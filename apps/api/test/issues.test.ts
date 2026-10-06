import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';

interface IssueBody {
  id: string;
  key: string;
  number: number;
  status: string;
  closedAt: string | null;
}

describe('issues', () => {
  let ctx: TestContext;
  let projectId: string;
  let otherProjectId: string;

  const createIssue = (payload: Record<string, unknown>) =>
    ctx.request({ method: 'POST', url: '/api/issues', payload: { projectId, ...payload } });
  const issue = async (payload: Record<string, unknown>): Promise<IssueBody> =>
    (await createIssue(payload)).json();
  const patch = (ref: string, payload: Record<string, unknown>) =>
    ctx.request({ method: 'PATCH', url: `/api/issues/${ref}`, payload });

  beforeAll(async () => {
    ctx = await createTestContext();
    const project = await ctx.request({
      method: 'POST',
      url: '/api/projects',
      payload: { key: 'CVX', name: 'Conclavix' },
    });
    projectId = project.json().id;
    const other = await ctx.request({
      method: 'POST',
      url: '/api/projects',
      payload: { key: 'OTH', name: 'Other' },
    });
    otherProjectId = other.json().id;
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('numbering and lookup', () => {
    it('numbers issues per project and resolves them by key and id', async () => {
      const first = await createIssue({ title: 'First' });
      expect(first.statusCode).toBe(201);
      expect(first.json()).toMatchObject({
        key: 'CVX-1',
        number: 1,
        status: 'todo',
        closedAt: null,
      });
      const other = await ctx.request({
        method: 'POST',
        url: '/api/issues',
        payload: { projectId: otherProjectId, title: 'Elsewhere' },
      });
      expect(other.json().key).toBe('OTH-1');

      const byKey = await ctx.request({ method: 'GET', url: '/api/issues/CVX-1' });
      expect(byKey.json().id).toBe(first.json().id);
      const byId = await ctx.request({ method: 'GET', url: `/api/issues/${first.json().id}` });
      expect(byId.json().key).toBe('CVX-1');
    });

    it('hands out unique, gapless numbers under concurrent creation', async () => {
      const before = (await issue({ title: 'before' })).number;
      const created = await Promise.all(
        Array.from({ length: 20 }, (_, i) => createIssue({ title: `parallel ${i}` })),
      );
      expect(created.every((response) => response.statusCode === 201)).toBe(true);
      const numbers = created.map((response) => response.json().number).sort((a, b) => a - b);
      expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => before + 1 + i));
    });

    it('returns 404 for unknown refs and 400 for invalid input', async () => {
      expect((await ctx.request({ method: 'GET', url: '/api/issues/CVX-9999' })).statusCode).toBe(
        404,
      );
      expect((await ctx.request({ method: 'GET', url: '/api/issues/nonsense' })).statusCode).toBe(
        404,
      );
      expect((await createIssue({ title: 'x', status: 'done' })).statusCode).toBe(400);
      expect((await createIssue({ title: 'x', owner: 'me' })).statusCode).toBe(400);
    });

    it('refuses issues in an archived project', async () => {
      const archived = await ctx.request({
        method: 'POST',
        url: '/api/projects',
        payload: { key: 'ARC', name: 'Archived' },
      });
      await ctx.request({
        method: 'PATCH',
        url: `/api/projects/${archived.json().id}`,
        payload: { status: 'archived' },
      });
      const response = await ctx.request({
        method: 'POST',
        url: '/api/issues',
        payload: { projectId: archived.json().id, title: 'x' },
      });
      expect(response.statusCode).toBe(422);
    });
  });

  describe('tree', () => {
    it('rejects parents that are missing, foreign, closed or cyclic', async () => {
      const missing = await createIssue({ title: 'x', parentId: '0123456789abcdef01234567' });
      expect(missing.statusCode).toBe(422);

      const foreign = await ctx.request({
        method: 'POST',
        url: '/api/issues',
        payload: { projectId: otherProjectId, title: 'foreign parent' },
      });
      expect((await createIssue({ title: 'x', parentId: foreign.json().id })).statusCode).toBe(422);

      const closed = await issue({ title: 'closed parent' });
      await patch(closed.key, { status: 'cancelled' });
      expect((await createIssue({ title: 'x', parentId: closed.id })).statusCode).toBe(422);

      const root = await issue({ title: 'root' });
      const child = await issue({ title: 'child', parentId: root.id });
      const grandchild = await issue({ title: 'grandchild', parentId: child.id });
      expect((await patch(root.key, { parentId: grandchild.id })).statusCode).toBe(422);
      expect((await patch(root.key, { parentId: root.id })).statusCode).toBe(422);
    });

    it('closes a parent only after its children, and refuses to reopen under a closed parent', async () => {
      const parent = await issue({ title: 'epic' });
      const child = await issue({ title: 'task', parentId: parent.id });

      expect((await patch(parent.key, { status: 'done' })).statusCode).toBe(422);
      expect((await patch(child.key, { status: 'done' })).json().closedAt).not.toBeNull();
      const closedParent = await patch(parent.key, { status: 'done' });
      expect(closedParent.statusCode).toBe(200);
      expect(closedParent.json().closedAt).not.toBeNull();

      expect((await patch(child.key, { status: 'todo' })).statusCode).toBe(422);
      const reopened = await patch(parent.key, { status: 'in_progress' });
      expect(reopened.json().closedAt).toBeNull();
      expect((await patch(child.key, { status: 'todo' })).statusCode).toBe(200);
    });

    it('never ends with a closed parent and an open child under concurrency', async () => {
      for (let round = 0; round < 10; round += 1) {
        const parent = await issue({ title: `race parent ${round}` });
        await Promise.all([
          createIssue({ title: `race child ${round}`, parentId: parent.id }),
          patch(parent.key, { status: 'done' }),
        ]);
        const after = (
          await ctx.request({ method: 'GET', url: `/api/issues/${parent.key}` })
        ).json();
        const children = (
          await ctx.request({ method: 'GET', url: `/api/issues?parentId=${parent.id}` })
        ).json().items;
        const openChildren = children.filter((child: IssueBody) => child.status !== 'done');
        expect(after.status === 'done' && openChildren.length > 0).toBe(false);
      }
    });
  });
});
