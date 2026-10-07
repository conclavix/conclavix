import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mediaQuerySchema, type MediaListing } from '@conclavix/core';
import { Git, GitError } from '../src/modules/workspace/git.js';
import { Workspace } from '../src/modules/workspace/service.js';
import { createUser, signIn } from './auth-helpers.js';
import { createTestContext, type TestContext } from './helpers.js';
import { commitAll, git, tempRoot } from './workspace-helpers.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const OTHER_PNG = Buffer.concat([PNG, Buffer.from([0])]);
const MP4 = Buffer.from('0000ftypisom-video-bytes-0123456789');
const PDF = Buffer.from('%PDF-1.4\n%fake\n');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>\n';

type Role = 'owner' | 'admin' | 'member' | 'viewer';
const ROLES: Role[] = ['owner', 'admin', 'member', 'viewer'];

/** Commit everything in `cwd` with a fixed author and committer date. */
function commitAt(cwd: string, message: string, date: string): string {
  process.env['GIT_AUTHOR_DATE'] = date;
  process.env['GIT_COMMITTER_DATE'] = date;
  try {
    return commitAll(cwd, message);
  } finally {
    delete process.env['GIT_AUTHOR_DATE'];
    delete process.env['GIT_COMMITTER_DATE'];
  }
}

function write(dir: string, files: Record<string, Buffer | string>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
}

describe('project media API', () => {
  let ctx: TestContext;
  let root: { dir: string; cleanup: () => void };
  let workspace: Workspace;
  let projectId: string;
  let keyA: string;
  let keyB: string;
  let tipA: string;
  let tipB: string;
  const cookies = {} as Record<Role, string>;

  const media = async (query = ''): Promise<MediaListing> => {
    const response = await ctx.request({
      method: 'GET',
      url: `/api/projects/${projectId}/media${query ? `?${query}` : ''}`,
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  };

  const newIssue = async (title: string): Promise<string> => {
    const issue = await ctx.request({
      method: 'POST',
      url: '/api/issues',
      payload: { projectId, title },
    });
    const key = issue.json().key as string;
    await ctx.request({ method: 'POST', url: `/api/issues/${key}/workspace` });
    return key;
  };

  const sync = async (key: string) => {
    const synced = await ctx.request({
      method: 'POST',
      url: `/api/issues/${key}/workspace/sync`,
      payload: {},
    });
    expect(synced.statusCode).toBe(200);
  };

  beforeAll(async () => {
    root = tempRoot();
    workspace = new Workspace(root.dir);
    ctx = await createTestContext({ workspace, settingsDefaults: { mfaPolicy: 'optional' } });
    for (const role of ROLES) {
      await createUser(ctx, `${role}@example.com`, role);
      cookies[role] = (await signIn(ctx, `${role}@example.com`)).cookie;
    }
    const project = await ctx.request({
      method: 'POST',
      url: '/api/projects',
      payload: { key: 'MED', name: 'Media', autoPlan: false },
    });
    projectId = project.json().id;

    keyA = await newIssue('Feedback form');
    // Both branches start from the empty main.
    keyB = await newIssue('Settings page');
    const cloneA = workspace.issueWorkspaceDir(projectId, keyA);
    write(cloneA, {
      'docs/screenshots/feedback/list.png': PNG,
      'docs/screenshots/feedback/icon.svg': SVG,
      'docs/screenshots/feedback/flow.mp4': MP4,
      'docs/report.pdf': PDF,
      'docs/notes.txt': 'not media\n',
    });
    tipA = commitAt(cloneA, 'Add feedback screenshots', '2026-10-01T10:00:00Z');
    await sync(keyA);
    // main catches up with the first issue branch, so its files are on both.
    git(workspace.repoDir(projectId), 'update-ref', 'refs/heads/main', tipA);

    const cloneB = workspace.issueWorkspaceDir(projectId, keyB);
    write(cloneB, {
      'docs/screenshots/settings/copy-of-list.png': PNG,
      'docs/screenshots/settings/dark.png': OTHER_PNG,
    });
    tipB = commitAt(cloneB, 'Add settings screenshots', '2026-10-02T10:00:00Z');
    await sync(keyB);
  });

  afterAll(async () => {
    await ctx.close();
    root.cleanup();
  });

  it('lists images, videos and PDFs once per blob, with branches, issue and commit', async () => {
    const listing = await media();
    expect(listing.total).toBe(5);
    expect(listing.truncated).toBe(false);
    expect(listing.history).toBe('complete');
    expect(listing.scannedBranches).toBe(3);
    expect(listing.items.map((item) => item.path).sort()).toEqual([
      'docs/report.pdf',
      'docs/screenshots/feedback/flow.mp4',
      'docs/screenshots/feedback/icon.svg',
      'docs/screenshots/feedback/list.png',
      'docs/screenshots/settings/dark.png',
    ]);
    const list = listing.items.find((item) => item.name === 'list.png');
    expect(list).toMatchObject({
      kind: 'image',
      contentType: 'image/png',
      size: PNG.length,
      ref: tipA,
      commit: { sha: tipA, authorName: 'Test Agent', committedAt: '2026-10-01T10:00:00Z' },
    });
    expect(list?.locations).toEqual([
      { branch: 'main', issueKey: null, path: 'docs/screenshots/feedback/list.png' },
      { branch: `cvx/${keyB}`, issueKey: keyB, path: 'docs/screenshots/settings/copy-of-list.png' },
      { branch: `cvx/${keyA}`, issueKey: keyA, path: 'docs/screenshots/feedback/list.png' },
    ]);
    const dark = listing.items.find((item) => item.name === 'dark.png');
    expect(dark).toMatchObject({ ref: tipB, commit: { sha: tipB } });
    expect(dark?.locations).toEqual([
      { branch: `cvx/${keyB}`, issueKey: keyB, path: 'docs/screenshots/settings/dark.png' },
    ]);
    expect(listing.items.find((item) => item.name === 'flow.mp4')?.kind).toBe('video');
    expect(listing.items.find((item) => item.name === 'report.pdf')?.kind).toBe('pdf');
    expect(listing.facets.kinds).toEqual({ image: 3, video: 1, pdf: 1 });
    expect(listing.facets.branches).toEqual([
      { name: 'main', issueKey: null, count: 4 },
      { name: `cvx/${keyB}`, issueKey: keyB, count: 2 },
      { name: `cvx/${keyA}`, issueKey: keyA, count: 4 },
    ]);
  });

  it('addresses every item by a commit at which its path holds the blob', async () => {
    for (const item of (await media()).items) {
      const response = await ctx.request({
        method: 'GET',
        url: `/api/projects/${projectId}/raw?ref=${item.ref}&path=${encodeURIComponent(item.path)}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['etag']).toBe(`"${item.oid}"`);
      expect(response.headers['cache-control']).toContain('immutable');
    }
  });

  it('filters by kind, branch and path and sorts by date', async () => {
    expect((await media('kind=video')).items.map((i) => i.name)).toEqual(['flow.mp4']);
    expect(
      (await media(`branch=${encodeURIComponent(`cvx/${keyB}`)}`)).items.map((i) => i.name),
    ).toEqual(['dark.png', 'list.png']);
    expect((await media('q=COPY-OF')).items.map((i) => i.name)).toEqual(['list.png']);
    expect((await media('q=settings&sort=oldest')).items.map((i) => i.name)).toEqual([
      'list.png',
      'dark.png',
    ]);
    expect((await media('branch=cvx%2FNOPE-1')).total).toBe(0);
  });

  it('pages through the list', async () => {
    const first = await media('limit=2');
    expect(first.items).toHaveLength(2);
    expect(first.items[0]?.name).toBe('dark.png');
    expect(first.nextOffset).toBe(2);
    const second = await media('limit=2&offset=2');
    expect(second.version).toBe(first.version);
    const last = await media('limit=2&offset=4');
    expect(last.items).toHaveLength(1);
    expect(last.nextOffset).toBeNull();
    expect(last.total).toBe(5);
  });

  it('caches a scan until a branch tip moves', async () => {
    const a = await workspace.mediaScan(projectId);
    const [b, c] = await Promise.all([
      workspace.mediaScan(projectId),
      workspace.mediaScan(projectId),
    ]);
    expect(b).toBe(a);
    expect(c).toBe(a);
    const cloneB = workspace.issueWorkspaceDir(projectId, keyB);
    write(cloneB, { 'docs/screenshots/settings/new.webp': Buffer.from('RIFF0000WEBP') });
    commitAt(cloneB, 'Add another screenshot', '2026-10-03T10:00:00Z');
    await sync(keyB);
    const after = await workspace.mediaScan(projectId);
    expect(after).not.toBe(a);
    expect(after.version).toMatch(/^[0-9a-f]{16}$/);
    expect(after.version).not.toBe(a.version);
    expect(after.items.map((item) => item.name)).toContain('new.webp');
    expect((await media()).items[0]?.name).toBe('new.webp');
  });

  it('marks the scan truncated at the file and branch limits', async () => {
    const query = mediaQuerySchema.parse({});
    const fewItems = new Workspace(root.dir, { limits: { maxMediaItems: 2 } });
    const items = await fewItems.media(projectId, query);
    expect(items.total).toBe(2);
    expect(items.truncated).toBe(true);
    const oneBranch = new Workspace(root.dir, { limits: { maxMediaBranches: 1 } });
    const branches = await oneBranch.media(projectId, query);
    expect(branches.scannedBranches).toBe(1);
    expect(branches.truncated).toBe(true);
    expect(branches.facets.branches.map((b) => b.name)).toEqual(['main']);
    const noTime = new Workspace(root.dir, { limits: { mediaScanBudgetMs: -1 } });
    const none = await noTime.media(projectId, query);
    expect(none).toMatchObject({ total: 0, truncated: true, scannedBranches: 0 });
    const shortLog = new Workspace(root.dir, { limits: { maxMediaLogCommits: 1 } });
    const partial = await shortLog.media(projectId, query);
    expect(partial.total).toBe(6);
    expect(partial.truncated).toBe(false);
    expect(partial.history).toBe('limited');
    expect(partial.items.filter((item) => item.commit === null).length).toBeGreaterThan(0);
    for (const item of partial.items.filter((i) => i.commit === null)) {
      expect(item.ref).toMatch(/^[0-9a-f]{40,64}$/);
    }
  });

  /** A fresh reader whose `git log --raw` fails with `reason` while `fn` runs. */
  async function withFailingLog<T>(
    reason: 'exit' | 'timeout',
    fn: (fresh: Workspace, logCalls: () => number) => Promise<T>,
  ): Promise<T> {
    const run = Git.prototype.run;
    let calls = 0;
    const spy = vi.spyOn(Git.prototype, 'run').mockImplementation(function (this: Git, args, opts) {
      if (args.includes('log') && args.includes('--raw')) {
        calls += 1;
        return Promise.reject(new GitError('git log failed', null, '', reason));
      }
      return run.call(this, args, opts);
    });
    try {
      return await fn(new Workspace(root.dir), () => calls);
    } finally {
      spy.mockRestore();
    }
  }

  it('lists files without dates when the history walk fails and retries under a new version', async () => {
    const query = mediaQuerySchema.parse({});
    const { fresh, failed } = await withFailingLog('exit', async (reader) => ({
      fresh: reader,
      failed: await reader.media(projectId, query),
    }));
    expect(failed).toMatchObject({ total: 6, history: 'failed', truncated: false });
    expect(failed.items.every((item) => item.commit === null)).toBe(true);
    const retried = await fresh.media(projectId, query);
    expect(retried.history).toBe('complete');
    expect(retried.version).not.toBe(failed.version);
    expect(retried.items.every((item) => item.commit !== null)).toBe(true);
  });

  it('treats a history walk that runs out of time as limited and keeps the scan', async () => {
    const query = mediaQuerySchema.parse({});
    await withFailingLog('timeout', async (reader, logCalls) => {
      const first = await reader.media(projectId, query);
      expect(first.history).toBe('limited');
      const again = await reader.media(projectId, query);
      expect(again.version).toBe(first.version);
      expect(logCalls()).toBe(1);
    });
  });

  it('lets every role read the list and requires a session and a known project', async () => {
    for (const role of ROLES) {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/media`,
        headers: { cookie: cookies[role] },
      });
      expect(response.statusCode).toBe(200);
    }
    const anonymous = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/media`,
    });
    expect(anonymous.statusCode).toBe(401);
    const unknown = await ctx.request({
      method: 'GET',
      url: '/api/projects/bbbbbbbbbbbbbbbbbbbbbbbb/media',
    });
    expect(unknown.statusCode).toBe(404);
  });

  it.each(['kind=audio', 'limit=0', 'limit=500', 'offset=-1', 'sort=size', 'branch=-x', 'x=1'])(
    'rejects %s',
    async (query) => {
      const response = await ctx.request({
        method: 'GET',
        url: `/api/projects/${projectId}/media?${query}`,
      });
      expect(response.statusCode).toBe(400);
    },
  );

  describe('raw videos and PDFs', () => {
    const raw = (path: string, headers: Record<string, string> = {}) =>
      ctx.request({
        method: 'GET',
        url: `/api/projects/${projectId}/raw?ref=main&path=${encodeURIComponent(path)}`,
        headers,
      });

    it('serves a video with byte ranges', async () => {
      const full = await raw('docs/screenshots/feedback/flow.mp4');
      expect(full.statusCode).toBe(200);
      expect(full.headers['content-type']).toBe('video/mp4');
      expect(full.headers['accept-ranges']).toBe('bytes');
      expect(full.rawPayload.equals(MP4)).toBe(true);
      const part = await raw('docs/screenshots/feedback/flow.mp4', { range: 'bytes=4-7' });
      expect(part.statusCode).toBe(206);
      expect(part.headers['content-range']).toBe(`bytes 4-7/${MP4.length}`);
      expect(part.body).toBe('ftyp');
      const tail = await raw('docs/screenshots/feedback/flow.mp4', { range: 'bytes=-4' });
      expect(tail.body).toBe('6789');
      const beyond = await raw('docs/screenshots/feedback/flow.mp4', { range: 'bytes=999-' });
      expect(beyond.statusCode).toBe(416);
      expect(beyond.headers['content-range']).toBe(`bytes */${MP4.length}`);
      const stale = await raw('docs/screenshots/feedback/flow.mp4', {
        range: 'bytes=4-7',
        'if-range': '"0000000"',
      });
      expect(stale.statusCode).toBe(200);
    });

    it('serves a PDF only as a download', async () => {
      const response = await raw('docs/report.pdf');
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('application/pdf');
      expect(response.headers['content-disposition']).toBe('attachment; filename="report.pdf"');
      expect(response.headers['content-security-policy']).toContain('sandbox');
    });

    it('still refuses other files', async () => {
      expect((await raw('docs/notes.txt')).statusCode).toBe(415);
    });
  });
});
