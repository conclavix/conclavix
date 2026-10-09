import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import { parseMergeTree } from '../src/modules/workspace/merge.js';
import { Workspace } from '../src/modules/workspace/service.js';
import { commitAll, git, tempRoot } from './workspace-helpers.js';

const PROJECT = 'dddddddddddddddddddddddd';
const AUTHOR = { name: 'Conclavix Integrator', email: 'agent-7@users.noreply.example.com' };

describe('RepoMerger', () => {
  let root: { dir: string; cleanup: () => void };
  let ws: Workspace;
  let counter = 0;

  /** Clone the bare repository at `from`, let `work` commit, push HEAD to `target`. */
  function pushTo(from: string, target: string, files: Record<string, string>): string {
    counter += 1;
    const dir = join(root.dir, `helper-${counter}`);
    git(root.dir, 'clone', '--quiet', '--branch', from, ws.repoDir(PROJECT), dir);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    commitAll(dir, `change ${target}`);
    git(dir, 'push', '--quiet', 'origin', `HEAD:refs/heads/${target}`);
    return git(dir, 'rev-parse', 'HEAD');
  }

  const bare = (...args: string[]) => git(root.dir, `--git-dir=${ws.repoDir(PROJECT)}`, ...args);
  const tip = (branch: string) => bare('rev-parse', `refs/heads/${branch}`);
  const refs = () => bare('for-each-ref', '--format=%(refname) %(objectname)');

  async function refusal(work: Promise<unknown>): Promise<AppError> {
    const error = await work.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }

  beforeEach(async () => {
    root = tempRoot('cvx-merge-');
    ws = new Workspace(join(root.dir, 'ws'));
    await ws.ensureRepo(PROJECT);
    pushTo('main', 'main', { 'README.md': '# Demo\n', 'src/shared.ts': 'export const a = 1;\n' });
  });

  afterEach(() => root.cleanup());

  it('merges sources into a new issue branch cut from main, one no-ff commit each', async () => {
    const main = tip('main');
    const ten = pushTo('main', 'cvx/APP-10', { 'src/ten.ts': 'ten\n' });
    const eleven = pushTo('main', 'cvx/APP-11', { 'src/eleven.ts': 'eleven\n' });
    const merge = await ws.mergeIntoIssueBranch(PROJECT, 'APP-17', {
      sources: ['cvx/APP-10', 'cvx/APP-11'],
      message: 'Integrate the parser\r\nand the UI\u0007',
      author: AUTHOR,
      trailers: ['Conclavix-Issue: APP-17', 'Conclavix-Run: 1'],
    });
    expect(merge).toMatchObject({
      target: 'cvx/APP-17',
      status: 'merged',
      created: true,
      startedFrom: { ref: 'main', sha: main },
      before: null,
    });
    expect(merge.merges.map((step) => [step.source, step.sha])).toEqual([
      ['cvx/APP-10', ten],
      ['cvx/APP-11', eleven],
    ]);
    expect(tip('cvx/APP-17')).toBe(merge.after);
    expect(bare('rev-list', '--parents', '-n', '1', merge.after).split(' ')).toEqual([
      merge.after,
      merge.merges[0]?.commit,
      eleven,
    ]);
    expect(bare('rev-list', '--parents', '-n', '1', merge.merges[0]?.commit ?? '')).toBe(
      `${merge.merges[0]?.commit} ${main} ${ten}`,
    );
    expect(bare('log', '-1', '--format=%an <%ae>|%cn', merge.after)).toBe(
      'Conclavix Integrator <agent-7@users.noreply.example.com>|Conclavix Integrator',
    );
    const message = bare('log', '-1', '--format=%B', merge.after);
    expect(message.split('\n')[0]).toBe("Merge branch 'cvx/APP-11' into cvx/APP-17");
    expect(message).toContain('Integrate the parser\nand the UI');
    expect(message).not.toContain('\u0007');
    expect(message).toContain('Conclavix-Run: 1');
    expect(bare('ls-tree', '-r', '--name-only', merge.after).split('\n')).toEqual([
      'README.md',
      'src/eleven.ts',
      'src/shared.ts',
      'src/ten.ts',
    ]);
  });

  it('merges onto an existing target and skips sources it already contains', async () => {
    pushTo('main', 'cvx/APP-10', { 'src/ten.ts': 'ten\n' });
    const first = await ws.mergeIntoIssueBranch(PROJECT, 'APP-17', {
      sources: ['cvx/APP-10'],
      author: AUTHOR,
    });
    const own = pushTo('cvx/APP-17', 'cvx/APP-17', { 'src/own.ts': 'own\n' });
    pushTo('main', 'cvx/APP-11', { 'src/eleven.ts': 'eleven\n' });
    const second = await ws.mergeIntoIssueBranch(PROJECT, 'APP-17', {
      sources: ['cvx/APP-10', 'cvx/APP-11'],
      base: 'cvx/APP-11',
      author: AUTHOR,
    });
    expect(first.created).toBe(true);
    expect(second).toMatchObject({
      created: false,
      before: own,
      startedFrom: { ref: 'cvx/APP-17', sha: own },
    });
    expect(second.merges[0]?.commit).toBeNull();
    expect(bare('rev-parse', `${second.after}^1`)).toBe(own);

    const again = await ws.mergeIntoIssueBranch(PROJECT, 'APP-17', {
      sources: ['cvx/APP-11'],
      author: AUTHOR,
    });
    expect(again).toMatchObject({
      status: 'up_to_date',
      before: second.after,
      after: second.after,
    });
  });

  it('refuses a conflict with the files and leaves every ref as it was', async () => {
    pushTo('main', 'cvx/APP-10', { 'src/ten.ts': 'ten\n' });
    pushTo('main', 'cvx/APP-11', { 'src/shared.ts': 'export const a = 11;\n' });
    pushTo('main', 'cvx/APP-12', { 'src/shared.ts': 'export const a = 12;\n' });
    await ws.mergeIntoIssueBranch(PROJECT, 'APP-17', { sources: ['cvx/APP-11'], author: AUTHOR });
    const before = refs();
    const error = await refusal(
      ws.mergeIntoIssueBranch(PROJECT, 'APP-17', {
        sources: ['cvx/APP-10', 'cvx/APP-12'],
        author: AUTHOR,
      }),
    );
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe('merge_conflict');
    expect(error.details).toMatchObject({
      target: 'cvx/APP-17',
      source: 'cvx/APP-12',
      conflicts: [{ path: 'src/shared.ts', kinds: ['contents'] }],
      moreConflicts: 0,
      mergedCleanlyBefore: ['cvx/APP-10'],
    });
    expect(refs()).toBe(before);

    const fresh = await refusal(
      ws.mergeIntoIssueBranch(PROJECT, 'APP-18', {
        sources: ['cvx/APP-11', 'cvx/APP-12'],
        author: AUTHOR,
      }),
    );
    expect(fresh.code).toBe('merge_conflict');
    expect(refs()).not.toContain('refs/heads/cvx/APP-18');
  });

  it('validates sources and the base', async () => {
    pushTo('main', 'cvx/APP-10', { 'src/ten.ts': 'ten\n' });
    const sha = tip('cvx/APP-10');
    const cases: [string[], string | undefined, number][] = [
      [['cvx/APP-99'], undefined, 404],
      [[sha], undefined, 404],
      [['cvx/APP-10', 'cvx/APP-10'], undefined, 400],
      [['cvx/APP-17'], undefined, 400],
      [[], undefined, 400],
      [['-x'], undefined, 400],
      [['cvx/APP-10'], 'nope', 404],
    ];
    for (const [sources, base, status] of cases) {
      const error = await refusal(
        ws.mergeIntoIssueBranch(PROJECT, 'APP-17', {
          sources,
          ...(base ? { base } : {}),
          author: AUTHOR,
        }),
      );
      expect(error.statusCode, sources.join(',')).toBe(status);
    }
    expect(refs()).not.toContain('cvx/APP-17');
  });

  it('fast-forwards main only to a branch that contains it', async () => {
    const main = tip('main');
    const ahead = pushTo('main', 'cvx/APP-17', { 'src/feature.ts': 'feature\n' });
    const promoted = await ws.fastForwardBranch(PROJECT, 'main', 'cvx/APP-17');
    expect(promoted).toMatchObject({
      status: 'fast_forwarded',
      before: main,
      after: ahead,
      commits: 1,
    });
    expect(tip('main')).toBe(ahead);
    expect(await ws.fastForwardBranch(PROJECT, 'main', 'cvx/APP-17')).toMatchObject({
      status: 'up_to_date',
      commits: 0,
    });

    pushTo('main', 'main', { 'src/hotfix.ts': 'fix\n' });
    const mainNow = tip('main');
    pushTo('cvx/APP-17', 'cvx/APP-18', { 'src/later.ts': 'later\n' });
    const error = await refusal(ws.fastForwardBranch(PROJECT, 'main', 'cvx/APP-18'));
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe('not_fast_forward');
    expect(error.details).toMatchObject({ missingCommits: 1 });
    expect(tip('main')).toBe(mainNow);
    expect((await refusal(ws.fastForwardBranch(PROJECT, 'main', 'cvx/APP-404'))).statusCode).toBe(
      404,
    );
  });

  it('previews containment and conflicts without changing anything', async () => {
    pushTo('main', 'cvx/APP-10', { 'src/ten.ts': 'ten\n' });
    pushTo('main', 'cvx/APP-11', { 'src/shared.ts': 'export const a = 11;\n' });
    pushTo('main', 'cvx/APP-12', { 'src/shared.ts': 'export const a = 12;\n' });
    await ws.mergeIntoIssueBranch(PROJECT, 'APP-17', {
      sources: ['cvx/APP-10', 'cvx/APP-11'],
      author: AUTHOR,
    });
    const before = refs();
    const status = await ws.mergeStatus(PROJECT, 'cvx/APP-17', ['cvx/APP-10', 'cvx/APP-12']);
    expect(status).toMatchObject({
      target: 'cvx/APP-17',
      exists: true,
      ahead: 4,
      behind: 0,
      canFastForwardMain: true,
    });
    expect(status.sources.map((source) => [source.source, source.contained])).toEqual([
      ['cvx/APP-10', true],
      ['cvx/APP-12', false],
    ]);
    expect(status.sources[1]?.conflicts).toEqual([{ path: 'src/shared.ts', kinds: ['contents'] }]);
    const missing = await ws.mergeStatus(PROJECT, 'cvx/APP-30', ['cvx/APP-12']);
    expect(missing).toMatchObject({ exists: false, tip: null, canFastForwardMain: false });
    expect(missing.sources[0]?.conflicts).toEqual([]);
    expect(refs()).toBe(before);
  });

  it('runs no hook of the repository and no merge driver named in the content', async () => {
    pushTo('main', 'main', { '.gitattributes': '* merge=evil\n' });
    pushTo('main', 'cvx/APP-11', { 'src/shared.ts': 'export const a = 11;\n' });
    pushTo('main', 'cvx/APP-12', { 'src/other.ts': 'other\n' });
    // Written after the helper pushes, which run the bare repository's hooks themselves.
    const marker = join(root.dir, 'hook-ran');
    const hooks = join(ws.repoDir(PROJECT), 'hooks');
    mkdirSync(hooks, { recursive: true });
    for (const hook of ['reference-transaction', 'post-merge', 'pre-merge-commit']) {
      writeFileSync(join(hooks, hook), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    }
    const merge = await ws.mergeIntoIssueBranch(PROJECT, 'APP-17', {
      sources: ['cvx/APP-11', 'cvx/APP-12'],
      author: AUTHOR,
    });
    expect(merge.status).toBe('merged');
    expect(existsSync(marker)).toBe(false);
  });
});

describe('parseMergeTree', () => {
  it('reads the tree, the conflicted paths and their kinds', () => {
    const tree = 'a'.repeat(40);
    const output = [
      tree,
      'f',
      'g',
      '',
      '1',
      'f',
      'Auto-merging',
      'Auto-merging f\n',
      '1',
      'f',
      'CONFLICT (contents)',
      'CONFLICT (content): Merge conflict in f\n',
      '1',
      'g',
      'CONFLICT (modify/delete)',
      'CONFLICT (modify/delete): g deleted\n',
      '',
    ].join('\0');
    expect(parseMergeTree(output, false)).toEqual({
      tree,
      clean: false,
      conflicts: [
        { path: 'f', kinds: ['contents'] },
        { path: 'g', kinds: ['modify/delete'] },
      ],
      moreConflicts: 0,
    });
    expect(parseMergeTree(`${tree}\0`)).toEqual({
      tree,
      clean: true,
      conflicts: [],
      moreConflicts: 0,
    });
    expect(parseMergeTree(`${tree}\0\0`, false).clean).toBe(false);
    const unlisted = [tree, '', '1', 'dir', 'CONFLICT (directory rename split)', 'text', ''];
    expect(parseMergeTree(unlisted.join('\0'), false).conflicts).toEqual([
      { path: 'dir', kinds: ['directory rename split'] },
    ]);
    expect(() => parseMergeTree('nonsense')).toThrow();
  });
});
