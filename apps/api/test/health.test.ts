import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';

describe('health and auth', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('reports status and version without a token', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', version: 'test' });
  });

  it('rejects API calls without a token', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/projects' });
    expect(response.statusCode).toBe(401);
  });

  it('rejects API calls with a wrong token', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const response = await ctx.request({ method: 'GET', url: '/api/does-not-exist' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'not_found' });
  });
});
