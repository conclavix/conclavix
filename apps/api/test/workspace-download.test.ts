import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachmentDisposition, RAW_CSP } from '../src/modules/workspace/browse-routes.js';
import { folderArchiveNames } from '../src/modules/workspace/routes.js';
import { PNG, ROLES, ZIP_V2, createBrowseFixture, type BrowseFixture } from './browse-fixture.js';
import { readZip } from './workspace-helpers.js';

describe('file downloads and folder archives', () => {
  let fx: BrowseFixture;
  const enc = encodeURIComponent;
  const download = (path: string, ref = fx.branch, extra = '') =>
    fx.get(
      `/api/projects/${fx.projectId}/raw?ref=${enc(ref)}&path=${enc(path)}&download=1${extra}`,
    );
  const archive = (query: string) => fx.get(`/api/projects/${fx.projectId}/archive?${query}`);

  beforeAll(async () => {
    fx = await createBrowseFixture('DL');
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it('sends a text file as an octet-stream attachment to every role', async () => {
    for (const role of ROLES) {
      const response = await fx.get(
        `/api/projects/${fx.projectId}/raw?ref=${enc(fx.branch)}&path=src%2Fapp.ts&download=true`,
        role,
      );
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('export const a = 2;\n');
      expect(response.headers['content-type']).toBe('application/octet-stream');
      expect(response.headers['content-disposition']).toBe(
        `attachment; filename="app.ts"; filename*=UTF-8''app.ts`,
      );
      expect(response.headers['content-length']).toBe('20');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-security-policy']).toBe(RAW_CSP);
      expect(response.headers['etag']).toMatch(/^"[0-9a-f]{40,64}"$/);
    }
  });

  it('sends binary files byte for byte and answers 304 for a known ETag', async () => {
    const response = await download('assets/data.zip');
    expect(response.rawPayload.equals(ZIP_V2)).toBe(true);
    expect(response.headers['content-type']).toBe('application/octet-stream');
    const again = await download('assets/data.zip', fx.branch);
    expect(again.headers['etag']).toBe(response.headers['etag']);
    const cached = await fx.get(
      `/api/projects/${fx.projectId}/raw?ref=${enc(fx.branch)}&path=assets%2Fdata.zip&download=1`,
      'viewer',
      { 'if-none-match': String(response.headers['etag']) },
    );
    expect(cached.statusCode).toBe(304);
  });

  it('keeps raster images typed but never serves SVG, HTML or JS inline', async () => {
    const png = await download('assets/logo.png');
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.headers['content-disposition']).toMatch(/^attachment;/);
    expect(png.rawPayload.equals(PNG)).toBe(true);
    for (const path of ['assets/icon.svg', 'assets/page.html', 'assets/app.js']) {
      const response = await download(path);
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('application/octet-stream');
      expect(response.headers['content-disposition']).toMatch(/^attachment;/);
      expect(response.headers['content-security-policy']).toContain('sandbox');
    }
  });

  it('encodes non-ASCII and quoted file names per RFC 5987', async () => {
    const response = await download('Übersicht "Plan".txt');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="_bersicht_Plan_.txt"; filename*=UTF-8''%C3%9Cbersicht%20%22Plan%22.txt`,
    );
    expect(attachmentDisposition("it's (1).txt")).toContain(
      `filename*=UTF-8''it%27s%20%281%29.txt`,
    );
  });

  it('refuses files above the download limit before reading them', async () => {
    const response = await download('assets/big.bin');
    expect(response.statusCode).toBe(413);
    expect(response.json().error).toBe('file_too_large');
  });

  it('answers HEAD with the download headers and the same refusals', async () => {
    const head = (path: string) =>
      fx.ctx.app.inject({
        method: 'HEAD',
        url: `/api/projects/${fx.projectId}/raw?ref=${enc(fx.branch)}&path=${enc(path)}&download=1`,
        headers: { cookie: fx.cookies.viewer },
      });
    const ok = await head('assets/data.zip');
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('application/octet-stream');
    expect(ok.headers['content-length']).toBe(String(ZIP_V2.length));
    expect(ok.headers['content-disposition']).toMatch(/^attachment;/);
    expect(ok.rawPayload).toHaveLength(0);
    expect((await head('assets/big.bin')).statusCode).toBe(413);
    expect((await head('missing.txt')).statusCode).toBe(404);
  });

  it.each([
    ['path=..%2Fsecret&download=1', 400],
    ['path=%2Fetc%2Fpasswd&download=1', 400],
    ['path=-x&download=1', 400],
    ['ref=-n&path=a&download=1', 400],
    ['path=a&download=maybe', 400],
    ['path=missing.txt&download=1', 404],
  ])('rejects %s', async (query, status) => {
    const response = await fx.get(`/api/projects/${fx.projectId}/raw?${query}`);
    expect(response.statusCode).toBe(status);
  });

  it('refuses directories and keeps the inline mode for media only', async () => {
    expect((await download('src')).statusCode).toBe(404);
    const inline = await fx.get(
      `/api/projects/${fx.projectId}/raw?ref=${enc(fx.branch)}&path=src%2Fapp.ts`,
    );
    expect(inline.statusCode).toBe(415);
  });

  it('requires a session', async () => {
    const response = await fx.ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${fx.projectId}/raw?path=README.md&download=1`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('zips one folder, rooted at the folder name', async () => {
    const response = await archive(`ref=${enc(fx.branch)}&path=src`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/zip');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="DL-${fx.branch.replace('/', '-')}-src.zip"`,
    );
    const entries = readZip(response.rawPayload);
    expect([...entries.keys()].filter((name) => !name.endsWith('/')).sort()).toEqual([
      'src/app.ts',
      'src/lib/util.ts',
    ]);
    expect(entries.get('src/app.ts')?.toString()).toBe('export const a = 2;\n');
  });

  it('zips nested folders and names with spaces', async () => {
    const nested = readZip((await archive(`ref=${enc(fx.branch)}&path=src%2Flib`)).rawPayload);
    expect([...nested.keys()].filter((name) => !name.endsWith('/'))).toEqual(['lib/util.ts']);
    const spaced = readZip((await archive(`ref=${enc(fx.branch)}&path=docs%2Fa%20b`)).rawPayload);
    expect([...spaced.keys()].filter((name) => !name.endsWith('/'))).toEqual(['a-b/notes.md']);
    expect(folderArchiveNames('DL', 'a'.repeat(40), 'x/y')).toEqual({
      file: `DL-${'a'.repeat(12)}-y`,
      root: 'y',
    });
  });

  it('still zips the whole ref without a path and audits the folder', async () => {
    const whole = await archive(`ref=${enc(fx.branch)}`);
    const names = [...readZip(whole.rawPayload).keys()];
    expect(names.some((name) => name.endsWith('/README.md'))).toBe(true);
    const audit = await fx.ctx.request({
      method: 'GET',
      url: '/api/audit?action=project.archive_downloaded',
    });
    const paths = audit
      .json()
      .items.map((item: { details: { path?: string } }) => item.details.path);
    expect(paths).toContain('src');
  });

  it.each([
    ['path=README.md', 404],
    ['path=nope', 404],
    ['path=..%2Fx', 400],
    ['path=src%2F', 400],
    ['ref=main..x&path=src', 400],
  ])('rejects the folder archive %s', async (query, status) => {
    expect((await archive(query)).statusCode).toBe(status);
  });
});
