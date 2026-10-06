import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';

describe('board UI and the board-token boundary', () => {
  let ctx: TestContext;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'cvx-web-'));
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'index.html'), '<!doctype html><title>Conclavix</title>');
    await writeFile(join(root, 'assets', 'app.js'), 'console.log(1)');
    ctx = await createTestContext({ webRoot: root });
    await ctx.request({
      method: 'POST',
      url: '/api/projects',
      payload: { key: 'SEC', name: 'Secret' },
    });
  });

  afterAll(async () => {
    await ctx.close();
    await rm(root, { recursive: true });
  });

  it('serves the UI and client-side routes without a token', async () => {
    for (const url of ['/', '/issues/SEC-1', '/org']) {
      const response = await ctx.app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<title>Conclavix</title>');
    }
    const asset = await ctx.app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(asset.body).toBe('console.log(1)');
    const stale = await ctx.app.inject({ method: 'GET', url: '/assets/index-old.js' });
    expect(stale.statusCode).toBe(404);
    expect(stale.body).not.toContain('<title>');
  });

  it('keeps the whole board API behind the token, including unknown and oddly written paths', async () => {
    for (const url of ['/api/projects', '/api/does-not-exist', '/api/projects?x=1']) {
      expect((await ctx.app.inject({ method: 'GET', url })).statusCode).toBe(401);
    }
    for (const url of ['//api/projects', '/api/../api/projects', '/%2Fapi/projects']) {
      const response = await ctx.app.inject({ method: 'GET', url });
      expect(response.body).not.toContain('SEC');
    }
    expect((await ctx.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });
});
