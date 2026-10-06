import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Workspace } from '../src/modules/workspace/service.js';
import { createUser, signIn } from './auth-helpers.js';
import { createTestContext, type TestContext } from './helpers.js';
import { commitAll, tempRoot } from './workspace-helpers.js';

/** A 1x1 transparent PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>\n';
const MAX_RAW = 4096;

type Role = 'owner' | 'admin' | 'member' | 'viewer';
const ROLES: Role[] = ['owner', 'admin', 'member', 'viewer'];

describe('raw repository images', () => {
  let ctx: TestContext;
  let root: { dir: string; cleanup: () => void };
  let workspace: Workspace;
  let projectId: string;
  let branch: string;
  let headSha: string;
  const cookies = {} as Record<Role, string>;

  const raw = (query: string, headers: Record<string, string> = {}) =>
    ctx.request({ method: 'GET', url: `/api/projects/${projectId}/raw?${query}`, headers });
  const rawOf = (path: string, ref = branch) =>
    raw(`ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`);

  beforeAll(async () => {
    root = tempRoot();
    workspace = new Workspace(root.dir, { limits: { maxRawBytes: MAX_RAW } });
    ctx = await createTestContext({ workspace, settingsDefaults: { mfaPolicy: 'optional' } });
    for (const role of ROLES) {
      await createUser(ctx, `${role}@example.com`, role);
      cookies[role] = (await signIn(ctx, `${role}@example.com`)).cookie;
    }
    const project = await ctx.request({
      method: 'POST',
      url: '/api/projects',
      payload: { key: 'RAW', name: 'Raw', autoPlan: false },
    });
    projectId = project.json().id;
    const issue = await ctx.request({
      method: 'POST',
      url: '/api/issues',
      payload: { projectId, title: 'Screenshots' },
    });
    const issueKey = issue.json().key as string;
    const created = await ctx.request({ method: 'POST', url: `/api/issues/${issueKey}/workspace` });
    branch = created.json().branch;

    const clone = workspace.issueWorkspaceDir(projectId, issueKey);
    const shots = join(clone, 'docs', 'screenshots', 'feedback');
    mkdirSync(shots, { recursive: true });
    writeFileSync(join(shots, 'list.png'), PNG);
    writeFileSync(join(shots, 'Photo.JPG'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1]));
    writeFileSync(join(shots, 'photo.jpeg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2]));
    writeFileSync(join(shots, 'anim.gif'), Buffer.from('GIF89a'));
    writeFileSync(join(shots, 'pic.webp'), Buffer.from('RIFF0000WEBP'));
    writeFileSync(join(shots, 'icon.svg'), SVG);
    writeFileSync(join(shots, 'notes.txt'), 'not an image\n');
    writeFileSync(join(shots, 'a.constructor'), 'not an image\n');
    writeFileSync(join(shots, 'a.__proto__'), 'not an image\n');
    writeFileSync(join(shots, 'huge.png'), Buffer.alloc(MAX_RAW + 1, 1));
    mkdirSync(join(shots, 'folder.png'));
    writeFileSync(join(shots, 'folder.png', 'inner.txt'), 'x\n');
    headSha = commitAll(clone, 'Add screenshots');
    const synced = await ctx.request({
      method: 'POST',
      url: `/api/issues/${issueKey}/workspace/sync`,
      payload: {},
    });
    expect(synced.json()).toMatchObject({ updated: true, after: headSha });
  });

  afterAll(async () => {
    await ctx.close();
    root.cleanup();
  });

  it('serves a PNG to every role with a session cookie, ETag and revalidation', async () => {
    for (const role of ROLES) {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/raw?ref=${encodeURIComponent(branch)}&path=docs/screenshots/feedback/list.png`,
        headers: { cookie: cookies[role] },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('image/png');
      expect(response.rawPayload.equals(PNG)).toBe(true);
      expect(response.headers['etag']).toMatch(/^"[0-9a-f]{40,64}"$/);
      expect(response.headers['cache-control']).toBe('private, no-cache');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    }
  });

  it('answers 304 when the ETag still matches', async () => {
    const first = await rawOf('docs/screenshots/feedback/list.png');
    const etag = String(first.headers['etag']);
    const again = await raw(
      `ref=${encodeURIComponent(branch)}&path=docs/screenshots/feedback/list.png`,
      { 'if-none-match': `W/${etag}` },
    );
    expect(again.statusCode).toBe(304);
    expect(again.rawPayload).toHaveLength(0);
  });

  it('lets the browser keep images addressed by a full commit id', async () => {
    const response = await rawOf('docs/screenshots/feedback/list.png', headSha);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, max-age=31536000, immutable');
  });

  it.each([
    ['Photo.JPG', 'image/jpeg'],
    ['photo.jpeg', 'image/jpeg'],
    ['anim.gif', 'image/gif'],
    ['pic.webp', 'image/webp'],
    ['icon.svg', 'image/svg+xml'],
  ])('serves %s as %s', async (name, type) => {
    const response = await rawOf(`docs/screenshots/feedback/${name}`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe(type);
  });

  it('sandboxes SVG opened on its own', async () => {
    const response = await rawOf('docs/screenshots/feedback/icon.svg');
    expect(response.body).toBe(SVG);
    expect(response.headers['content-security-policy']).toContain('sandbox');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('refuses files above the size limit with 413', async () => {
    const response = await rawOf('docs/screenshots/feedback/huge.png');
    expect(response.statusCode).toBe(413);
    expect(response.json().error).toBe('file_too_large');
  });

  it('serves only images', async () => {
    expect((await rawOf('docs/screenshots/feedback/notes.txt')).statusCode).toBe(415);
    expect((await rawOf('docs/screenshots/feedback/a.constructor')).statusCode).toBe(415);
    expect((await rawOf('docs/screenshots/feedback/a.__proto__')).statusCode).toBe(415);
    expect((await rawOf('docs/screenshots')).statusCode).toBe(415);
    expect((await rawOf('docs/screenshots/feedback/folder.png')).statusCode).toBe(404);
    expect((await rawOf('docs/screenshots/feedback/missing.png')).statusCode).toBe(404);
    expect((await rawOf('docs/screenshots/feedback/list.png', 'main')).statusCode).toBe(404);
  });

  it.each([
    ['ref=-n&path=a.png', 400],
    ['ref=main..x&path=a.png', 400],
    ['ref=unknown&path=a.png', 404],
    ['path=..%2F..%2Fetc%2Fx.png', 400],
    ['path=%2Fetc%2Fx.png', 400],
    ['path=-x.png', 400],
    ['path=', 400],
    ['path=a.png&extra=1', 400],
  ])('rejects %s', async (query, status) => {
    expect((await raw(query)).statusCode).toBe(status);
  });

  it('requires a session or token and a known project', async () => {
    const anonymous = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/raw?ref=${encodeURIComponent(branch)}&path=docs/screenshots/feedback/list.png`,
    });
    expect(anonymous.statusCode).toBe(401);
    const unknown = await ctx.request({
      method: 'GET',
      url: '/api/projects/bbbbbbbbbbbbbbbbbbbbbbbb/raw?path=a.png',
    });
    expect(unknown.statusCode).toBe(404);
  });
});
