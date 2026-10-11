import type { RefDiff } from '@conclavix/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLES, createBrowseFixture, type BrowseFixture } from './browse-fixture.js';

describe('diffs for review', () => {
  let fx: BrowseFixture & { dangling: string };
  const diff = async (query: string, role: (typeof ROLES)[number] = 'viewer') =>
    fx.get(`/api/projects/${fx.projectId}/diff?${query}`, role);
  const ok = async (query: string): Promise<RefDiff> => {
    const response = await diff(query);
    expect(response.statusCode).toBe(200);
    return response.json();
  };
  const paths = (result: RefDiff) => result.diff.files.map((file) => file.path).sort();
  const branch = () => encodeURIComponent(fx.branch);

  beforeAll(async () => {
    fx = await createBrowseFixture('DIFF', { maxPatchLines: 400 });
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it('shows a commit against its parent, with binary files marked', async () => {
    const result = await ok(`commit=${fx.head}`);
    expect(result).toMatchObject({
      mode: 'commit',
      toSha: fx.head,
      fromSha: fx.base,
      diffBase: fx.base,
    });
    expect(result.commits.map((commit) => commit.sha)).toEqual([fx.head]);
    expect(paths(result)).toEqual(['assets/data.zip', 'long.txt', 'src/app.ts']);
    const binary = result.diff.files.find((file) => file.path === 'assets/data.zip');
    expect(binary).toMatchObject({ binary: true, patch: null });
  });

  it('compares from the merge base by default and directly on request', async () => {
    const mergeBase = await ok(`from=main&to=${branch()}`);
    expect(mergeBase).toMatchObject({
      mode: 'merge-base',
      from: 'main',
      to: fx.branch,
      mergeBase: fx.base,
      diffBase: fx.base,
      ahead: 1,
      behind: 1,
    });
    expect(paths(mergeBase)).toEqual(['assets/data.zip', 'long.txt', 'src/app.ts']);

    const direct = await ok(`from=main&to=${branch()}&mode=direct`);
    expect(direct).toMatchObject({ mode: 'direct', diffBase: fx.mainOnly });
    expect(paths(direct)).toEqual(['MAIN.md', 'assets/data.zip', 'long.txt', 'src/app.ts']);
    expect(direct.diff.files.find((file) => file.path === 'MAIN.md')?.status).toBe('deleted');
  });

  it('defaults from to main and accepts tags and reachable commit ids', async () => {
    expect((await ok(`to=${branch()}`)).from).toBe('main');
    const tagged = await ok(`from=v1&to=${fx.head.slice(0, 10)}&mode=direct`);
    expect(tagged).toMatchObject({ fromSha: fx.base, toSha: fx.head });
  });

  it('cuts long file diffs and shows the whole file diff on request', async () => {
    const result = await ok(`from=main&to=${branch()}`);
    const long = result.diff.files.find((file) => file.path === 'long.txt');
    expect(long?.truncated).toBe(true);
    expect(long?.patch?.split('\n')).toHaveLength(50);
    expect(result.diff.truncated).toBe(true);

    const full = await ok(`from=main&to=${branch()}&path=long.txt`);
    expect(full.path).toBe('long.txt');
    expect(full.diff.files).toHaveLength(1);
    expect(full.diff.files[0]?.truncated).toBe(false);
    expect(full.diff.files[0]?.patch?.split('\n').length).toBeGreaterThan(200);
    const commitFull = await ok(`commit=${fx.head}&path=long.txt`);
    expect(commitFull.diff.files[0]?.truncated).toBe(false);
  });

  it('caps the lines of the whole diff', async () => {
    const capped = await createBrowseFixture('CAP', {
      maxFilePatchLines: 1000,
      maxPatchLines: 100,
    });
    try {
      const response = await capped.get(
        `/api/projects/${capped.projectId}/diff?to=${encodeURIComponent(capped.branch)}`,
      );
      const result: RefDiff = response.json();
      const file = (path: string) => result.diff.files.find((entry) => entry.path === path);
      expect(file('long.txt')?.patch?.split('\n')).toHaveLength(100);
      expect(file('long.txt')?.truncated).toBe(true);
      expect(file('src/app.ts')).toMatchObject({ patch: null, truncated: true });
      expect(result.diff.truncated).toBe(true);
    } finally {
      await capped.cleanup();
    }
  });

  it.each([
    ['from=-x&to=main', 400],
    ['to=a..b', 400],
    ['to=unknown', 404],
    ['commit=zzz', 400],
    ['commit=abc&to=main', 400],
    ['commit=abcdef0&from=main', 400],
    ['from=main', 400],
    ['to=main&mode=sideways', 400],
    ['to=main&path=..%2Fx', 400],
    ['to=main&path=', 400],
    ['to=main&extra=1', 400],
  ])('rejects %s', async (query, status) => {
    expect((await diff(query)).statusCode).toBe(status);
  });

  it('refuses commits no branch or tag reaches', async () => {
    expect((await diff(`to=${fx.dangling}`)).statusCode).toBe(404);
    expect((await diff(`commit=${fx.dangling}`)).statusCode).toBe(404);
  });

  it('lets every role read diffs, but not anonymous callers', async () => {
    for (const role of ROLES) {
      expect((await diff(`commit=${fx.head}`, role)).statusCode).toBe(200);
    }
    const anonymous = await fx.ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${fx.projectId}/diff?commit=${fx.head}`,
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
