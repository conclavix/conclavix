import { existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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

describe('Workspace removal and sharing', () => {
  let root: { dir: string; cleanup: () => void };
  let ws: Workspace;

  beforeEach(() => {
    root = tempRoot();
    ws = new Workspace(root.dir);
  });

  afterEach(() => {
    root.cleanup();
  });

  async function agentCommits(files: Record<string, string>) {
    await ws.createIssueWorkspace(PROJECT, ISSUE);
    const clone = ws.issueWorkspaceDir(PROJECT, ISSUE);
    for (const [path, content] of Object.entries(files)) writeFileSync(join(clone, path), content);
    return { clone, sha: commitAll(clone, 'agent work') };
  }

  describe('unsynced work on other refs', () => {
    it('refuses removal while any branch, tag, stash or detached HEAD holds unsynced commits', async () => {
      const { clone } = await agentCommits({ 'a.txt': 'a\n' });
      await ws.syncIssueBranch(PROJECT, ISSUE, false);
      git(clone, 'checkout', '--quiet', '-b', 'side');
      writeFileSync(join(clone, 'side.txt'), 'side\n');
      commitAll(clone, 'work on a side branch');
      git(clone, 'checkout', '--quiet', 'cvx/CVX-7');
      expect(await statusOf(ws.removeIssueWorkspace(PROJECT, ISSUE, false))).toBe(409);

      git(clone, 'branch', '-D', 'side');
      git(clone, 'tag', 'keep', 'HEAD@{1}');
      expect(await statusOf(ws.removeIssueWorkspace(PROJECT, ISSUE, false))).toBe(409);
      git(clone, 'tag', '-d', 'keep');

      writeFileSync(join(clone, 'a.txt'), 'changed\n');
      git(clone, 'stash', '--quiet');
      expect(await statusOf(ws.removeIssueWorkspace(PROJECT, ISSUE, false))).toBe(409);
      git(clone, 'stash', 'drop', '--quiet');

      await ws.removeIssueWorkspace(PROJECT, ISSUE, false);
      expect(existsSync(clone)).toBe(false);
    });
  });

  describe('sharing with the runner', () => {
    it('uses the clone another process created first instead of failing', async () => {
      const other = new Workspace(root.dir);
      const [first, second] = await Promise.all([
        ws.createIssueWorkspace(PROJECT, ISSUE),
        other.createIssueWorkspace(PROJECT, ISSUE),
      ]);
      expect([first.created, second.created].filter(Boolean).length).toBeGreaterThanOrEqual(1);
      expect(second.cloneId).toBe(first.cloneId);
    });

    it('removes only old temporary directories a killed process left behind', async () => {
      const repos = join(root.dir, 'repos');
      mkdirSync(join(repos, `.init-${PROJECT}-dead`), { recursive: true });
      mkdirSync(join(repos, `.init-${PROJECT}-busy`), { recursive: true });
      const old = new Date(Date.now() - 2 * 60 * 60_000);
      utimesSync(join(repos, `.init-${PROJECT}-dead`), old, old);
      await ws.ensureRepo(PROJECT);
      expect(existsSync(join(repos, `.init-${PROJECT}-busy`))).toBe(true);
      expect(existsSync(join(repos, `.init-${PROJECT}-dead`))).toBe(false);
      const parent = join(root.dir, 'workspaces', PROJECT);
      mkdirSync(join(parent, `.clone-${ISSUE}-dead`), { recursive: true });
      utimesSync(join(parent, `.clone-${ISSUE}-dead`), old, old);
      await ws.createIssueWorkspace(PROJECT, ISSUE);
      expect(existsSync(join(parent, `.clone-${ISSUE}-dead`))).toBe(false);
    });

    it('creates repositories and clones group-writable for the shared group', async () => {
      await ws.createIssueWorkspace(PROJECT, ISSUE);
      const clone = ws.issueWorkspaceDir(PROJECT, ISSUE);
      expect(statSync(clone).mode & 0o7777).toBe(0o2770);
      expect(statSync(join(root.dir, 'workspaces', PROJECT)).mode & 0o7777).toBe(0o2770);
      expect(statSync(join(clone, '.git', 'HEAD')).mode & 0o777).toBe(0o660);
      expect(git(ws.repoDir(PROJECT), 'config', 'core.sharedRepository')).toBe('0660');
    });

    it('keeps the clone id while the clone exists and changes it for a new clone', async () => {
      const first = await ws.createIssueWorkspace(PROJECT, ISSUE);
      const again = await ws.createIssueWorkspace(PROJECT, ISSUE);
      expect(again.cloneId).toBe(first.cloneId);
      await ws.removeIssueWorkspace(PROJECT, ISSUE, true);
      const fresh = await ws.createIssueWorkspace(PROJECT, ISSUE);
      expect(fresh.cloneId).not.toBe(first.cloneId);
    });
  });
});
