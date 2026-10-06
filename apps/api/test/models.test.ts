import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';

describe('model suggestions', () => {
  let ctx: TestContext | undefined;

  afterEach(async () => {
    await ctx?.close();
    ctx = undefined;
  });

  it('lists the configured models in order', async () => {
    ctx = await createTestContext({
      settingsDefaults: { models: ['claude-opus-5-5', 'claude-haiku-4-5'] },
    });
    const response = await ctx.request({ method: 'GET', url: '/api/models' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: ['claude-opus-5-5', 'claude-haiku-4-5'] });
  });

  it('falls back to the default suggestions when nothing is configured', async () => {
    ctx = await createTestContext();
    const response = await ctx.request({ method: 'GET', url: '/api/models' });
    expect(response.json()).toEqual({ items: ['opus', 'sonnet', 'haiku'] });
  });

  it('serves the models instance setting over the ENV list', async () => {
    ctx = await createTestContext({ settingsDefaults: { models: ['claude-opus-5-5'] } });
    const patch = await ctx.request({
      method: 'PATCH',
      url: '/api/settings',
      payload: { models: ['claude-sonnet-5'] },
    });
    expect(patch.statusCode).toBe(200);
    const response = await ctx.request({ method: 'GET', url: '/api/models' });
    expect(response.json()).toEqual({ items: ['claude-sonnet-5'] });
  });

  it('requires authentication', async () => {
    ctx = await createTestContext({ settingsDefaults: { models: ['claude-opus-5-5'] } });
    const response = await ctx.request({
      method: 'GET',
      url: '/api/models',
      headers: { authorization: '' },
    });
    expect(response.statusCode).toBe(401);
  });
});
