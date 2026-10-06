import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';

describe('comments and documents', () => {
  let ctx: TestContext;
  let issueKey: string;

  const put = (key: string, payload: Record<string, unknown>) =>
    ctx.request({ method: 'PUT', url: `/api/issues/${issueKey}/documents/${key}`, payload });

  beforeAll(async () => {
    ctx = await createTestContext();
    const project = await ctx.request({
      method: 'POST',
      url: '/api/projects',
      payload: { key: 'DOC', name: 'Docs' },
    });
    const issue = await ctx.request({
      method: 'POST',
      url: '/api/issues',
      payload: { projectId: project.json().id, title: 'Write the plan' },
    });
    issueKey = issue.json().key;
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('comments', () => {
    it('appends comments as the board and pages through them in order', async () => {
      for (let i = 0; i < 3; i += 1) {
        const created = await ctx.request({
          method: 'POST',
          url: `/api/issues/${issueKey}/comments`,
          payload: { body: `comment ${i}` },
        });
        expect(created.statusCode).toBe(201);
        expect(created.json().author).toEqual({ type: 'board' });
      }
      const first = (
        await ctx.request({ method: 'GET', url: `/api/issues/${issueKey}/comments?limit=2` })
      ).json();
      expect(first.items.map((c: { body: string }) => c.body)).toEqual(['comment 0', 'comment 1']);
      const rest = (
        await ctx.request({
          method: 'GET',
          url: `/api/issues/${issueKey}/comments?after=${first.nextCursor}`,
        })
      ).json();
      expect(rest.items.map((c: { body: string }) => c.body)).toEqual(['comment 2']);
      expect(rest.nextCursor).toBeNull();
    });

    it('rejects empty bodies, a forged author and unknown issues', async () => {
      const url = `/api/issues/${issueKey}/comments`;
      expect(
        (await ctx.request({ method: 'POST', url, payload: { body: '   ' } })).statusCode,
      ).toBe(400);
      const forged = await ctx.request({
        method: 'POST',
        url,
        payload: { body: 'hi', author: { type: 'agent', agentId: '0123456789abcdef01234567' } },
      });
      expect(forged.statusCode).toBe(400);
      const missing = await ctx.request({
        method: 'POST',
        url: '/api/issues/DOC-999/comments',
        payload: { body: 'hi' },
      });
      expect(missing.statusCode).toBe(404);
    });
  });

  describe('documents', () => {
    it('creates, updates with baseRevision and keeps every revision', async () => {
      const created = await put('plan', { title: 'Plan', body: 'v1' });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ key: 'plan', revision: 1, body: 'v1', title: 'Plan' });

      const updated = await put('plan', { body: 'v2', baseRevision: 1 });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({ revision: 2, body: 'v2', title: 'Plan' });

      const latest = (
        await ctx.request({ method: 'GET', url: `/api/issues/${issueKey}/documents/plan` })
      ).json();
      expect(latest).toMatchObject({ revision: 2, body: 'v2' });
      const old = (
        await ctx.request({
          method: 'GET',
          url: `/api/issues/${issueKey}/documents/plan/revisions/1`,
        })
      ).json();
      expect(old).toMatchObject({ revision: 1, body: 'v1' });
      const history = (
        await ctx.request({
          method: 'GET',
          url: `/api/issues/${issueKey}/documents/plan/revisions`,
        })
      ).json();
      expect(history.items.map((r: { revision: number }) => r.revision)).toEqual([2, 1]);
      expect(history.items[0]).not.toHaveProperty('body');

      const list = (
        await ctx.request({ method: 'GET', url: `/api/issues/${issueKey}/documents` })
      ).json();
      expect(list.items).toEqual([expect.objectContaining({ key: 'plan', revision: 2 })]);
    });

    it('rejects stale, missing and premature baseRevisions with 409 and the current revision', async () => {
      await put('spec', { body: 'a' });
      const stale = await put('spec', { body: 'b', baseRevision: 5 });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().details).toEqual({ currentRevision: 1 });
      const blind = await put('spec', { body: 'b' });
      expect(blind.statusCode).toBe(409);
      const premature = await put('notes', { body: 'x', baseRevision: 1 });
      expect(premature.statusCode).toBe(409);
      expect(premature.json().details).toEqual({ currentRevision: null });
    });

    it('lets exactly one of two concurrent writers win', async () => {
      for (let round = 0; round < 10; round += 1) {
        const key = `race-${round}`;
        await put(key, { body: 'base' });
        const results = await Promise.all([
          put(key, { body: 'left', baseRevision: 1 }),
          put(key, { body: 'right', baseRevision: 1 }),
        ]);
        expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
        const history = (
          await ctx.request({
            method: 'GET',
            url: `/api/issues/${issueKey}/documents/${key}/revisions`,
          })
        ).json();
        expect(history.items).toHaveLength(2);
      }
    });

    it('lets exactly one of two concurrent creators win', async () => {
      for (let round = 0; round < 10; round += 1) {
        const results = await Promise.all([
          put(`new-${round}`, { body: 'left' }),
          put(`new-${round}`, { body: 'right' }),
        ]);
        expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
      }
    });

    it('validates keys and revision numbers', async () => {
      expect((await put('Bad_Key', { body: 'x' })).statusCode).toBe(400);
      const badRevision = await ctx.request({
        method: 'GET',
        url: `/api/issues/${issueKey}/documents/plan/revisions/0`,
      });
      expect(badRevision.statusCode).toBe(400);
      const missingRevision = await ctx.request({
        method: 'GET',
        url: `/api/issues/${issueKey}/documents/plan/revisions/99`,
      });
      expect(missingRevision.statusCode).toBe(404);
    });
  });
});
