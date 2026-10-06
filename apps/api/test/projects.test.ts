import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';

describe('projects', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('creates, reads, lists and updates a project', async () => {
    const created = await ctx.request({
      method: 'POST',
      url: '/api/projects',
      payload: { key: 'CVX', name: 'Conclavix' },
    });
    expect(created.statusCode).toBe(201);
    const project = created.json();
    expect(project).toMatchObject({
      key: 'CVX',
      name: 'Conclavix',
      description: '',
      status: 'active',
    });

    const read = await ctx.request({ method: 'GET', url: `/api/projects/${project.id}` });
    expect(read.json()).toMatchObject({ id: project.id, key: 'CVX' });

    const updated = await ctx.request({
      method: 'PATCH',
      url: `/api/projects/${project.id}`,
      payload: { status: 'archived', description: 'done' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ status: 'archived', description: 'done', key: 'CVX' });

    const list = await ctx.request({ method: 'GET', url: '/api/projects' });
    expect(list.json().items.map((item: { id: string }) => item.id)).toContain(project.id);
  });

  it('rejects a duplicate key with 409', async () => {
    await ctx.request({ method: 'POST', url: '/api/projects', payload: { key: 'DUP', name: 'A' } });
    const second = await ctx.request({
      method: 'POST',
      url: '/api/projects',
      payload: { key: 'DUP', name: 'B' },
    });
    expect(second.statusCode).toBe(409);
  });

  it('rejects invalid keys and unknown fields with 400', async () => {
    const badKey = await ctx.request({
      method: 'POST',
      url: '/api/projects',
      payload: { key: 'lower', name: 'x' },
    });
    expect(badKey.statusCode).toBe(400);
    expect(badKey.json().details[0].path).toBe('key');

    const extra = await ctx.request({
      method: 'POST',
      url: '/api/projects',
      payload: { key: 'OK', name: 'x', owner: 'someone' },
    });
    expect(extra.statusCode).toBe(400);
  });

  it('does not allow changing the key', async () => {
    const created = await ctx.request({
      method: 'POST',
      url: '/api/projects',
      payload: { key: 'FIX', name: 'Fixed' },
    });
    const response = await ctx.request({
      method: 'PATCH',
      url: `/api/projects/${created.json().id}`,
      payload: { key: 'NEW' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 404 for unknown and malformed ids', async () => {
    const unknown = await ctx.request({
      method: 'GET',
      url: '/api/projects/0123456789abcdef01234567',
    });
    expect(unknown.statusCode).toBe(404);
    const malformed = await ctx.request({ method: 'GET', url: '/api/projects/not-an-id' });
    expect(malformed.statusCode).toBe(404);
  });
});
