import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import {
  outsidePaths,
  scopePaths,
  squashMessage,
  summarizeChanges,
} from '../src/modules/workspace/squash.js';
import { Workspace } from '../src/modules/workspace/service.js';
import { commitAll, git, tempRoot } from './workspace-helpers.js';

const PROJECT = 'eeeeeeeeeeeeeeeeeeeeeeee';
const AUTHOR = { name: 'Conclavix Integrator', email: 'agent-7@users.noreply.example.com' };
const TRAILERS = ['Conclavix-Issue: APP-17', 'Conclavix-Run: 1'];

describe('RepoSquasher', () => {
  let root: { dir: string; cleanup: () => void };
  let ws: Workspace;
  let counter = 0;

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

  const squash = (sources: string[], extra: { message?: string; paths?: string[] } = {}) =>
    ws.squashIntoIssueBranch(PROJECT, 'APP-17', {
      sources,
      message: extra.message ?? 'feat(feedback): add the Feedback module\n\nWith an inbox.',
      ...(extra.paths ? { paths: extra.paths } : {}),
      author: AUTHOR,
      trailers: TRAILERS,
    });

  beforeEach(async () => {
    root = tempRoot('cvx-squash-');
    ws = new Workspace(join(root.dir, 'ws'));
    await ws.ensureRepo(PROJECT);
    pushTo('main', 'main', { 'README.md': '# Demo\n', 'src/shared.ts': 'export const a = 1;\n' });
  });

  afterEach(() => root.cleanup());

  it('writes one commit on main with the merged tree, message and trailers', async () => {
    const main = tip('main');
    pushTo('main', 'cvx/APP-10', { 'modules/feedback/a.ts': 'a\n' });
    pushTo('cvx/APP-10', 'cvx/APP-10', { 'modules/feedback/b.ts': 'b\n' });
    pushTo('main', 'cvx/APP-11', { 'modules/feedback/c.ts': 'c\n' });
    const result = await squash(['cvx/APP-10', 'cvx/APP-11'], { paths: ['modules/feedback/'] });
    expect(result).toMatchObject({
      target: 'cvx/APP-17',
      status: 'merged',
      created: true,
      squash: true,
      before: null,
      startedFrom: { ref: 'main', sha: main },
      changes: { files: 3, topLevel: ['modules'], moreTopLevel: 0 },
    });
    expect(result.commit).toBe(result.after);
    expect(result.merges.map((step) => step.commit)).toEqual([result.after, result.after]);
    expect(tip('cvx/APP-17')).toBe(result.after);
    expect(bare('rev-list', '--parents', '-n', '1', result.after)).toBe(`${result.after} ${main}`);
    expect(bare('rev-list', '--count', `main..${result.after}`)).toBe('1');
    expect(bare('log', '-1', '--format=%an <%ae>|%cn', result.after)).toBe(
      'Conclavix Integrator <agent-7@users.noreply.example.com>|Conclavix Integrator',
    );
    expect(bare('log', '-1', '--format=%B', result.after)).toBe(
      'feat(feedback): add the Feedback module\n\nWith an inbox.\n\n' + TRAILERS.join('\n'),
    );

    const noff = await ws.mergeIntoIssueBranch(PROJECT, 'APP-18', {
      sources: ['cvx/APP-10', 'cvx/APP-11'],
      author: AUTHOR,
    });
    expect(bare('rev-parse', `${noff.after}^{tree}`)).toBe(
      bare('rev-parse', `${result.after}^{tree}`),
    );
  });

  it('squashes onto an existing target tip and reports nothing to do as up to date', async () => {
    pushTo('main', 'cvx/APP-10', { 'modules/x/a.ts': 'a\n' });
    const own = pushTo('main', 'cvx/APP-17', { 'modules/x/own.ts': 'own\n' });
    const result = await squash(['cvx/APP-10']);
    expect(result).toMatchObject({ created: false, before: own, status: 'merged' });
    expect(bare('rev-parse', `${result.after}^`)).toBe(own);
    const again = await squash(['cvx/APP-10']);
    expect(again).toMatchObject({ status: 'up_to_date', commit: null, after: result.after });
    expect(tip('cvx/APP-17')).toBe(result.after);
  });

  it('refuses conflicts and out-of-scope changes and changes no ref', async () => {
    pushTo('main', 'cvx/APP-11', { 'src/shared.ts': 'export const a = 11;\n' });
    pushTo('main', 'cvx/APP-12', { 'src/shared.ts': 'export const a = 12;\n' });
    pushTo('main', 'cvx/APP-13', { 'modules/x/a.ts': 'a\n', 'src/leak.ts': 'leak\n' });
    const before = refs();
    const conflict = await refusal(squash(['cvx/APP-11', 'cvx/APP-12']));
    expect(conflict).toMatchObject({ statusCode: 409, code: 'merge_conflict' });
    expect(conflict.details).toMatchObject({ source: 'cvx/APP-12' });
    const scope = await refusal(squash(['cvx/APP-13'], { paths: ['modules/x', 'modules/xy'] }));
    expect(scope).toMatchObject({ statusCode: 409, code: 'out_of_scope' });
    expect(scope.details).toMatchObject({ outside: ['src/leak.ts'], moreOutside: 0 });
    const message = await refusal(squash(['cvx/APP-13'], { message: ' \u0007\n\nbody only' }));
    expect(message).toMatchObject({ statusCode: 400, code: 'invalid_message' });
    expect(refs()).toBe(before);
  });

  it('previews a squash in the merge status without changing refs', async () => {
    pushTo('main', 'cvx/APP-10', { 'modules/x/a.ts': 'a\n', 'docs/x.md': 'x\n' });
    pushTo('main', 'cvx/APP-11', { 'src/shared.ts': 'export const a = 11;\n' });
    pushTo('main', 'cvx/APP-12', { 'src/shared.ts': 'export const a = 12;\n' });
    const before = refs();
    const clean = await ws.mergeStatus(PROJECT, 'cvx/APP-17', ['cvx/APP-10'], 'main', {
      squash: true,
    });
    expect(clean.squash).toEqual({
      clean: true,
      conflictSource: null,
      changes: { files: 2, topLevel: ['docs', 'modules'], moreTopLevel: 0 },
    });
    const unclean = await ws.mergeStatus(
      PROJECT,
      'cvx/APP-17',
      ['cvx/APP-11', 'cvx/APP-12'],
      'main',
      {
        squash: true,
      },
    );
    expect(unclean.squash).toEqual({ clean: false, conflictSource: 'cvx/APP-12', changes: null });
    expect((await ws.mergeStatus(PROJECT, 'cvx/APP-17', ['cvx/APP-10'])).squash).toBeUndefined();
    expect(refs()).toBe(before);
  });
});

describe('squash helpers', () => {
  it('validates the message and appends only server trailers', () => {
    expect(squashMessage('fix: x\r\n\r\nwhy\u0007', ['Conclavix-Run: 1'])).toBe(
      'fix: x\n\nwhy\n\nConclavix-Run: 1\n',
    );
    expect(squashMessage('fix: x')).toBe('fix: x\n');
    expect(() => squashMessage('')).toThrow(/subject/);
    expect(() => squashMessage('x'.repeat(101))).toThrow(/100/);
    expect(() => squashMessage('fix: x\n\nConclavix-Issue: APP-1')).toThrow(/trailers/);
    expect(() => squashMessage('fix: x\n\nconclavix-run : 2')).toThrow(/trailers/);
  });

  it('normalizes directory prefixes and finds paths outside them', () => {
    expect(scopePaths(['modules/x/', 'docs'])).toEqual(['modules/x', 'docs']);
    for (const bad of [[], ['/abs'], ['../up'], ['a/./b'], [''], ['a//b'], ['a\\b']]) {
      expect(() => scopePaths(bad), JSON.stringify(bad)).toThrow(AppError);
    }
    expect(outsidePaths(['modules/x/a', 'modules/x', 'modules/xy/b', 'r'], ['modules/x'])).toEqual([
      'modules/xy/b',
      'r',
    ]);
    expect(summarizeChanges(['b/1', 'a/2', 'b/3', 'top.md'])).toEqual({
      files: 4,
      topLevel: ['a', 'b', 'top.md'],
      moreTopLevel: 0,
    });
  });
});
