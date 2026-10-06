import { execFileSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import { Workspace } from '../src/modules/workspace/service.js';
import { commitAll, git, tempRoot } from './workspace-helpers.js';

const PROJECT = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ISSUE = 'CVX-7';

const statusOf = async (promise: Promise<unknown>): Promise<number> => {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof AppError) return error.statusCode;
    throw error;
  }
};

describe('Workspace', () => {
  let root: { dir: string; cleanup: () => void };
  let ws: Workspace;

  beforeEach(() => {
    root = tempRoot();
    ws = new Workspace(root.dir);
  });

  afterEach(() => {
    root.cleanup();
  });

  /** Create the issue clone and commit `files` in it, like an agent would. */
  async function agentCommits(files: Record<string, string | Buffer>, message = 'agent work') {
    await ws.createIssueWorkspace(PROJECT, ISSUE);
    const clone = ws.issueWorkspaceDir(PROJECT, ISSUE);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(clone, path, '..'), { recursive: true });
      writeFileSync(join(clone, path), content);
    }
    return { clone, sha: commitAll(clone, message) };
  }

  describe('repositories', () => {
    it('creates a bare repository with an empty initial commit on main', async () => {
      await ws.ensureRepo(PROJECT);
      const repo = ws.repoDir(PROJECT);
      expect(repo).toBe(join(root.dir, 'repos', `${PROJECT}.git`));
      expect(git(repo, 'rev-parse', '--is-bare-repository')).toBe('true');
      expect(git(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
      expect(git(repo, 'log', '--format=%s', 'main')).toBe('Initialize repository');
      expect(git(repo, 'ls-tree', 'main')).toBe('');
      expect(git(repo, 'remote')).toBe('');
    });

    it('is idempotent and safe under concurrent calls', async () => {
      await Promise.all([ws.ensureRepo(PROJECT), ws.ensureRepo(PROJECT), ws.ensureRepo(PROJECT)]);
      const other = new Workspace(root.dir);
      await other.ensureRepo(PROJECT);
      expect(git(ws.repoDir(PROJECT), 'rev-list', '--count', 'main')).toBe('1');
    });

    it('refuses project ids that are not object ids', () => {
      expect(() => ws.repoDir('../etc')).toThrow();
      expect(() => ws.issueWorkspaceDir(PROJECT, '../x')).toThrow();
    });

    it('lists main as the only branch of a new repository', async () => {
      const branches = await ws.listBranches(PROJECT);
      expect(branches).toHaveLength(1);
      expect(branches[0]).toMatchObject({ name: 'main', isDefault: true, ahead: 0, behind: 0 });
      expect(branches[0]?.lastCommit.subject).toBe('Initialize repository');
    });

    it('reports the git version', async () => {
      await expect(ws.checkGit()).resolves.toMatch(/^git version 2\./);
    });
  });

  describe('ref validation', () => {
    it.each(['-n', '--output=/tmp/x', 'foo.lock', '.hidden', 'a//b', 'x/', 'a@{1}', 'HEAD^'])(
      'rejects %s as a branch name',
      async (ref) => {
        expect(await statusOf(ws.resolveRef(PROJECT, ref))).toBe(400);
      },
    );

    it('answers 404 for an unknown branch or commit', async () => {
      expect(await statusOf(ws.resolveRef(PROJECT, 'nope'))).toBe(404);
      expect(await statusOf(ws.resolveRef(PROJECT, 'deadbeef'))).toBe(404);
    });

    it('resolves main and abbreviated commit ids to full ids', async () => {
      const main = await ws.resolveRef(PROJECT, 'main');
      expect(main.sha).toMatch(/^[0-9a-f]{40}$/);
      const short = await ws.resolveRef(PROJECT, main.sha.slice(0, 8));
      expect(short.sha).toBe(main.sha);
    });
  });

  describe('issue workspaces', () => {
    it('clones the issue branch without hardlinks and without a remote', async () => {
      const created = await ws.createIssueWorkspace(PROJECT, ISSUE);
      expect(created).toMatchObject({ issueKey: ISSUE, branch: 'cvx/CVX-7', created: true });
      const clone = ws.issueWorkspaceDir(PROJECT, ISSUE);
      expect(clone).toBe(join(root.dir, 'workspaces', PROJECT, ISSUE));
      expect(git(clone, 'symbolic-ref', '--short', 'HEAD')).toBe('cvx/CVX-7');
      expect(git(clone, 'remote')).toBe('');
      expect(existsSync(join(clone, '.git', 'objects', 'info', 'alternates'))).toBe(false);
      const objects = git(clone, 'count-objects', '-v');
      expect(objects).toMatch(/count: \d+|in-pack: \d+/);
      const commit = git(clone, 'rev-parse', 'HEAD');
      const loose = join(clone, '.git', 'objects', commit.slice(0, 2), commit.slice(2));
      if (existsSync(loose)) expect(statSync(loose).nlink).toBe(1);
      expect(git(ws.repoDir(PROJECT), 'rev-parse', 'refs/heads/cvx/CVX-7')).toBe(commit);
    });

    it('returns an existing clone unchanged', async () => {
      await ws.createIssueWorkspace(PROJECT, ISSUE);
      const again = await ws.createIssueWorkspace(PROJECT, ISSUE);
      expect(again.created).toBe(false);
      expect(again.head).toMatch(/^[0-9a-f]{40}$/);
    });

    it('fetches the issue branch back fast-forward only', async () => {
      const { clone, sha } = await agentCommits({ 'src/a.ts': 'export const a = 1;\n' });
      const repo = ws.repoDir(PROJECT);
      expect(git(repo, 'rev-parse', 'cvx/CVX-7')).not.toBe(sha);

      const synced = await ws.syncIssueBranch(PROJECT, ISSUE, false);
      expect(synced).toMatchObject({ updated: true, after: sha, forced: false });
      expect(git(repo, 'rev-parse', 'cvx/CVX-7')).toBe(sha);
      expect(git(repo, 'rev-parse', 'main')).not.toBe(sha);

      git(clone, 'commit', '--quiet', '--amend', '-m', 'rewritten');
      expect(await statusOf(ws.syncIssueBranch(PROJECT, ISSUE, false))).toBe(409);
      expect(git(repo, 'rev-parse', 'cvx/CVX-7')).toBe(sha);

      const forced = await ws.syncIssueBranch(PROJECT, ISSUE, true);
      expect(forced.forced).toBe(true);
      expect(git(repo, 'rev-parse', 'cvx/CVX-7')).toBe(git(clone, 'rev-parse', 'HEAD'));
    });

    it('fetches nothing but the issue branch', async () => {
      const { clone } = await agentCommits({ 'a.txt': 'a\n' });
      git(clone, 'branch', 'cvx/CVX-8');
      git(clone, 'branch', '-f', 'main');
      git(clone, 'tag', 'v1');
      const repo = ws.repoDir(PROJECT);
      const mainBefore = git(repo, 'rev-parse', 'main');
      await ws.syncIssueBranch(PROJECT, ISSUE, false);
      expect(git(repo, 'rev-parse', 'main')).toBe(mainBefore);
      expect(git(repo, 'branch', '--list', 'cvx/CVX-8')).toBe('');
      expect(git(repo, 'tag')).toBe('');
    });

    it('runs no hooks, fsmonitor or ssh command configured in the clone', async () => {
      const { clone } = await agentCommits({ 'a.txt': 'a\n' });
      writeFileSync(join(clone, 'b.txt'), 'b\n');
      commitAll(clone, 'second');
      const marker = join(root.dir, 'pwned');
      const script = join(root.dir, 'evil.sh');
      writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> ${marker}\n`, { mode: 0o755 });
      const hooks = join(clone, '.git', 'hooks');
      for (const hook of ['pre-upload', 'post-checkout', 'reference-transaction', 'post-update']) {
        writeFileSync(join(hooks, hook), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
      }
      git(clone, 'config', 'core.hooksPath', hooks);
      git(clone, 'config', 'core.fsmonitor', script);
      git(clone, 'config', 'core.sshCommand', script);
      git(clone, 'config', 'uploadpack.packObjectsHook', script);
      git(clone, 'config', 'core.pager', script);
      expect(existsSync(marker)).toBe(false);

      await ws.syncIssueBranch(PROJECT, ISSUE, false);
      await ws.createIssueWorkspace(PROJECT, ISSUE);
      expect(existsSync(marker)).toBe(false);
    });

    it.skipIf(process.getuid?.() !== 0)('syncs a clone that belongs to another user', async () => {
      const { clone, sha } = await agentCommits({ 'a.txt': 'a\n' });
      execFileSync('chown', ['-R', '65534:65534', clone]);
      const synced = await ws.syncIssueBranch(PROJECT, ISSUE, false);
      expect(synced.after).toBe(sha);
    });

    it.skipIf(process.getuid?.() !== 0)(
      'clones a bare repository that belongs to another user',
      async () => {
        await ws.ensureRepo(PROJECT);
        execFileSync('chown', ['-R', '65534:65534', ws.repoDir(PROJECT)]);
        const created = await ws.createIssueWorkspace(PROJECT, ISSUE);
        expect(created.created).toBe(true);
        const clone = ws.issueWorkspaceDir(PROJECT, ISSUE);
        expect(git(clone, 'rev-parse', 'HEAD')).toBe(created.head);
        const { sha } = await agentCommits({ 'a.txt': 'a\n' });
        const synced = await ws.syncIssueBranch(PROJECT, ISSUE, false);
        expect(synced.after).toBe(sha);
      },
    );

    it('refuses a clone whose .git points elsewhere', async () => {
      await ws.createIssueWorkspace(PROJECT, ISSUE);
      const clone = ws.issueWorkspaceDir(PROJECT, ISSUE);
      const gitDir = join(clone, '.git');

      writeFileSync(
        join(gitDir, 'objects', 'info', 'alternates'),
        `${ws.repoDir(PROJECT)}/objects\n`,
      );
      expect(await statusOf(ws.syncIssueBranch(PROJECT, ISSUE, false))).toBe(422);
      await rm(join(gitDir, 'objects', 'info', 'alternates'));

      writeFileSync(join(gitDir, 'commondir'), ws.repoDir(PROJECT));
      expect(await statusOf(ws.syncIssueBranch(PROJECT, ISSUE, false))).toBe(422);
      await rm(join(gitDir, 'commondir'));

      await rm(gitDir, { recursive: true, force: true });
      writeFileSync(gitDir, `gitdir: ${ws.repoDir(PROJECT)}\n`);
      expect(await statusOf(ws.syncIssueBranch(PROJECT, ISSUE, false))).toBe(422);

      await rm(gitDir);
      symlinkSync(ws.repoDir(PROJECT), gitDir);
      expect(await statusOf(ws.syncIssueBranch(PROJECT, ISSUE, false))).toBe(422);
    });

    it('refuses symlinks, hardlinks and special files inside the clone .git', async () => {
      const other = 'bbbbbbbbbbbbbbbbbbbbbbbb';
      await ws.ensureRepo(other);
      await agentCommits({ 'a.txt': 'a\n' });
      const gitDir = join(ws.issueWorkspaceDir(PROJECT, ISSUE), '.git');
      const ref = join(gitDir, 'refs', 'heads', 'cvx', ISSUE);
      const loose = readFileSync(ref, 'utf8');

      await rm(ref);
      symlinkSync(join(ws.repoDir(other), 'refs', 'heads', 'main'), ref);
      expect(await statusOf(ws.syncIssueBranch(PROJECT, ISSUE, false))).toBe(422);
      await rm(ref);

      writeFileSync(join(root.dir, 'outside'), loose);
      linkSync(join(root.dir, 'outside'), ref);
      expect(await statusOf(ws.syncIssueBranch(PROJECT, ISSUE, false))).toBe(422);
      await rm(ref);

      execFileSync('mkfifo', [join(gitDir, 'fifo')]);
      expect(await statusOf(ws.syncIssueBranch(PROJECT, ISSUE, false))).toBe(422);
      await rm(join(gitDir, 'fifo'));

      writeFileSync(ref, loose);
      const objects = join(gitDir, 'objects');
      await rm(objects, { recursive: true, force: true });
      symlinkSync(join(ws.repoDir(other), 'objects'), objects);
      expect(await statusOf(ws.syncIssueBranch(PROJECT, ISSUE, false))).toBe(422);
      expect(await statusOf(ws.removeIssueWorkspace(PROJECT, ISSUE, false))).toBe(422);
    });

    it('keeps unsynced commits unless removal is forced, and keeps the branch', async () => {
      const { clone } = await agentCommits({ 'a.txt': 'a\n' });
      expect(await statusOf(ws.removeIssueWorkspace(PROJECT, ISSUE, false))).toBe(409);
      expect(existsSync(clone)).toBe(true);

      await ws.syncIssueBranch(PROJECT, ISSUE, false);
      writeFileSync(join(clone, 'dirty.txt'), 'uncommitted\n');
      await ws.removeIssueWorkspace(PROJECT, ISSUE, false);
      expect(existsSync(clone)).toBe(false);
      expect(git(ws.repoDir(PROJECT), 'branch', '--list', 'cvx/CVX-7')).toContain('cvx/CVX-7');
      expect(await statusOf(ws.removeIssueWorkspace(PROJECT, ISSUE, false))).toBe(404);

      const again = await ws.createIssueWorkspace(PROJECT, ISSUE);
      expect(again.created).toBe(true);
      expect(readFileSync(join(clone, 'a.txt'), 'utf8')).toBe('a\n');
      git(clone, 'checkout', '--quiet', '-b', 'elsewhere');
      git(clone, 'branch', '-D', 'cvx/CVX-7');
      expect(await statusOf(ws.removeIssueWorkspace(PROJECT, ISSUE, false))).toBe(409);
      writeFileSync(join(clone, 'c.txt'), 'c\n');
      commitAll(clone, 'unsynced');
      await ws.removeIssueWorkspace(PROJECT, ISSUE, true);
      expect(existsSync(clone)).toBe(false);
    });
  });

  describe('reading', () => {
    it('lists trees and reads files at a branch', async () => {
      await agentCommits({
        'README.md': '# Demo\n',
        'src/index.ts': 'export {};\n',
        'src/lib/util.ts': 'export const x = 1;\n',
      });
      await ws.syncIssueBranch(PROJECT, ISSUE, false);

      const top = await ws.tree(PROJECT, 'cvx/CVX-7', '');
      expect(top.entries.map((e) => [e.name, e.type])).toEqual([
        ['src', 'tree'],
        ['README.md', 'blob'],
      ]);
      const src = await ws.tree(PROJECT, 'cvx/CVX-7', 'src');
      expect(src.entries.map((e) => e.path)).toEqual(['src/lib', 'src/index.ts']);
      const file = await ws.file(PROJECT, 'cvx/CVX-7', 'src/lib/util.ts');
      expect(file).toMatchObject({ content: 'export const x = 1;\n', binary: false, size: 20 });
      expect(await statusOf(ws.file(PROJECT, 'main', 'README.md'))).toBe(404);
      expect(await statusOf(ws.file(PROJECT, 'cvx/CVX-7', 'src'))).toBe(404);
      expect(await statusOf(ws.tree(PROJECT, 'cvx/CVX-7', 'README.md'))).toBe(404);
    });

    it.each(['../README.md', 'src/../README.md', '/etc/passwd', 'src//a.ts', './README.md', '-p'])(
      'rejects the path %s',
      async (path) => {
        await agentCommits({ 'README.md': 'x\n', 'src/a.ts': 'a\n' });
        await ws.syncIssueBranch(PROJECT, ISSUE, false);
        expect(await statusOf(ws.file(PROJECT, 'cvx/CVX-7', path))).toBe(400);
        expect(await statusOf(ws.tree(PROJECT, 'cvx/CVX-7', path))).toBe(400);
      },
    );

    it.each([':(glob)**', '*', 'src/*', 'src/?.ts', ':!README.md'])(
      'treats %s as a literal path inside the commit',
      async (path) => {
        await agentCommits({ 'README.md': 'x\n', 'src/a.ts': 'a\n' });
        await ws.syncIssueBranch(PROJECT, ISSUE, false);
        expect(await statusOf(ws.file(PROJECT, 'cvx/CVX-7', path))).toBe(404);
      },
    );

    it('flags binary and oversized files instead of returning their content', async () => {
      const small = new Workspace(root.dir, { limits: { maxFileBytes: 100 } });
      await agentCommits({
        'logo.bin': Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]),
        'big.txt': 'x'.repeat(500),
      });
      await ws.syncIssueBranch(PROJECT, ISSUE, false);
      expect(await small.file(PROJECT, 'cvx/CVX-7', 'logo.bin')).toMatchObject({
        binary: true,
        content: null,
        tooLarge: false,
      });
      expect(await small.file(PROJECT, 'cvx/CVX-7', 'big.txt')).toMatchObject({
        tooLarge: true,
        content: null,
        size: 500,
      });
    });

    it('pages the commit log', async () => {
      const { clone } = await agentCommits({ 'a.txt': '1\n' }, 'one');
      writeFileSync(join(clone, 'a.txt'), '2\n');
      commitAll(clone, 'two');
      await ws.syncIssueBranch(PROJECT, ISSUE, false);
      const first = await ws.log(PROJECT, { ref: 'cvx/CVX-7', limit: 2, skip: 0 });
      expect(first.items.map((c) => c.subject)).toEqual(['two', 'one']);
      expect(first.nextSkip).toBe(2);
      const second = await ws.log(PROJECT, { ref: 'cvx/CVX-7', limit: 2, skip: 2 });
      expect(second.items.map((c) => c.subject)).toEqual(['Initialize repository']);
      expect(second.nextSkip).toBeNull();
      expect(first.items[0]).toMatchObject({
        authorName: 'Test Agent',
        parents: [expect.any(String)],
      });
    });

    it('shows a commit with its diff, renames and binary files', async () => {
      const { clone } = await agentCommits({ 'old.txt': 'same\n', 'gone.txt': 'bye\n' }, 'base');
      git(clone, 'mv', 'old.txt', 'new.txt');
      writeFileSync(join(clone, 'img.bin'), Buffer.from([0, 1, 2, 3]));
      writeFileSync(join(clone, 'add.ts'), 'line1\nline2\n');
      await rm(join(clone, 'gone.txt'));
      const sha = commitAll(clone, 'change\n\nwith a body');
      await ws.syncIssueBranch(PROJECT, ISSUE, false);

      const detail = await ws.commit(PROJECT, sha.slice(0, 10));
      expect(detail).toMatchObject({ sha, subject: 'change', body: 'with a body' });
      const byPath = Object.fromEntries(detail.diff.files.map((f) => [f.path, f]));
      expect(byPath['new.txt']).toMatchObject({ status: 'renamed', oldPath: 'old.txt' });
      expect(byPath['img.bin']).toMatchObject({ status: 'added', binary: true, patch: null });
      expect(byPath['add.ts']).toMatchObject({ status: 'added', additions: 2, deletions: 0 });
      expect(byPath['add.ts']?.patch).toBe('@@ -0,0 +1,2 @@\n+line1\n+line2');
      expect(byPath['gone.txt']).toMatchObject({ status: 'deleted', deletions: 1 });
      expect(detail.diff.truncated).toBe(false);

      const root0 = await ws.log(PROJECT, { ref: 'main', limit: 1, skip: 0 });
      const initial = await ws.commit(PROJECT, root0.items[0]?.sha ?? '');
      expect(initial.diff.files).toEqual([]);
      expect(await statusOf(ws.commit(PROJECT, 'ffffffffff'))).toBe(404);
    });

    it('cuts diffs at the patch limits', async () => {
      const tight = new Workspace(root.dir, {
        limits: { maxFilePatchBytes: 200, maxPatchBytes: 600 },
      });
      const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
      const { sha } = await agentCommits({
        'a.txt': lines(100),
        'b.txt': lines(100),
        'c.txt': 'c\n',
      });
      await ws.syncIssueBranch(PROJECT, ISSUE, false);
      const detail = await tight.commit(PROJECT, sha);
      expect(detail.diff.truncated).toBe(true);
      expect(detail.diff.files).toHaveLength(3);
      const a = detail.diff.files.find((f) => f.path === 'a.txt');
      expect(a?.truncated).toBe(true);
      expect(Buffer.byteLength(a?.patch ?? '')).toBeLessThanOrEqual(200);
    });

    it('cuts the file list of a huge diff instead of failing', async () => {
      const files = Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`file-${i}.txt`, `${i}\n`]),
      );
      const { sha } = await agentCommits(files);
      await ws.syncIssueBranch(PROJECT, ISSUE, false);
      const tight = new Workspace(root.dir, { limits: { maxListBytes: 600 } });
      const detail = await tight.commit(PROJECT, sha);
      expect(detail.diff.truncated).toBe(true);
      expect(detail.diff.files.length).toBeGreaterThan(0);
      expect(detail.diff.files.length).toBeLessThan(40);
      for (const file of detail.diff.files) expect(file.path).toMatch(/^file-\d+\.txt$/);
    });

    it('compares a branch with main', async () => {
      const { clone } = await agentCommits({ 'a.txt': 'a\n' }, 'feature');
      writeFileSync(join(clone, 'a.txt'), 'b\n');
      commitAll(clone, 'feature 2');
      await ws.syncIssueBranch(PROJECT, ISSUE, false);
      const compared = await ws.compare(PROJECT, 'cvx/CVX-7');
      expect(compared).toMatchObject({ base: 'main', head: 'cvx/CVX-7', ahead: 2, behind: 0 });
      expect(compared.commits.map((c) => c.subject)).toEqual(['feature 2', 'feature']);
      expect(compared.diff.files).toEqual([
        expect.objectContaining({ path: 'a.txt', status: 'added', patch: '@@ -0,0 +1 @@\n+b' }),
      ]);
      const branches = await ws.listBranches(PROJECT);
      expect(branches.map((b) => [b.name, b.ahead, b.issueKey])).toEqual([
        ['main', 0, null],
        ['cvx/CVX-7', 2, 'CVX-7'],
      ]);
      expect(await statusOf(ws.compare(PROJECT, 'nope'))).toBe(404);

      const capped = new Workspace(root.dir, { limits: { maxBranches: 1 } });
      expect((await capped.listBranches(PROJECT)).map((b) => b.name)).toEqual(['main']);
      expect(await statusOf(ws.compare(PROJECT, '-x'))).toBe(400);
    });
  });
});
