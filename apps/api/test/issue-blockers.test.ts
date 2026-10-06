import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';

interface IssueBody {
  id: string;
  key: string;
}

describe('issue blockers, assignment and listing', () => {
  let ctx: TestContext;
  let projectId: string;

  const issue = async (payload: Record<string, unknown>): Promise<IssueBody> =>
    (
      await ctx.request({ method: 'POST', url: '/api/issues', payload: { projectId, ...payload } })
    ).json();
  const patch = (ref: string, payload: Record<string, unknown>) =>
    ctx.request({ method: 'PATCH', url: `/api/issues/${ref}`, payload });

  beforeAll(async () => {
    ctx = await createTestContext();
    const project = await ctx.request({
      method: 'POST',
      url: '/api/projects',
      payload: { key: 'BLK', name: 'Blockers' },
    });
    projectId = project.json().id;
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('rejects self, missing and cyclic blockers', async () => {
    const a = await issue({ title: 'A' });
    const b = await issue({ title: 'B', blockedBy: [a.id] });
    const c = await issue({ title: 'C', blockedBy: [b.id] });

    expect((await patch(a.key, { blockedBy: [a.id] })).statusCode).toBe(422);
    expect((await patch(a.key, { blockedBy: ['0123456789abcdef01234567'] })).statusCode).toBe(422);
    expect((await patch(a.key, { blockedBy: [b.id] })).statusCode).toBe(422);
    expect((await patch(a.key, { blockedBy: [c.id] })).statusCode).toBe(422);
    expect((await patch(c.key, { blockedBy: [a.id, b.id, b.id] })).json().blockedBy).toEqual([
      a.id,
      b.id,
    ]);
  });

  it('never lets concurrent updates close a dependency cycle', async () => {
    for (let round = 0; round < 10; round += 1) {
      const a = await issue({ title: `race A${round}` });
      const b = await issue({ title: `race B${round}` });
      const results = await Promise.all([
        patch(a.key, { blockedBy: [b.id] }),
        patch(b.key, { blockedBy: [a.id] }),
      ]);
      expect(results.map((response) => response.statusCode).sort()).toEqual([200, 422]);
    }
  });

  it('validates assignees and blocks deleting an agent with open issues', async () => {
    expect(
      (
        await patch((await issue({ title: 'x' })).key, {
          assigneeAgentId: '0123456789abcdef01234567',
        })
      ).statusCode,
    ).toBe(422);

    const agent = (
      await ctx.request({
        method: 'POST',
        url: '/api/agents',
        payload: { name: 'Worker', role: 'engineer', adapter: { type: 'claude_cli' } },
      })
    ).json();
    const work = await issue({ title: 'assigned', assigneeAgentId: agent.id });

    expect(
      (await ctx.request({ method: 'DELETE', url: `/api/agents/${agent.id}` })).statusCode,
    ).toBe(409);
    await patch(work.key, { status: 'done' });
    expect(
      (await ctx.request({ method: 'DELETE', url: `/api/agents/${agent.id}` })).statusCode,
    ).toBe(204);
  });

  it('refuses to reopen an issue whose assignee was deleted, unless it is reassigned', async () => {
    const agent = (
      await ctx.request({
        method: 'POST',
        url: '/api/agents',
        payload: { name: 'Former', role: 'x', adapter: { type: 'claude_cli' } },
      })
    ).json();
    const work = await issue({ title: 'finished work', assigneeAgentId: agent.id });
    await patch(work.key, { status: 'done' });
    expect(
      (await ctx.request({ method: 'DELETE', url: `/api/agents/${agent.id}` })).statusCode,
    ).toBe(204);

    const reopen = await patch(work.key, { status: 'todo' });
    expect(reopen.statusCode).toBe(422);

    const reassigned = await patch(work.key, { status: 'todo', assigneeAgentId: null });
    expect(reassigned.statusCode).toBe(200);
    expect(reassigned.json()).toMatchObject({ status: 'todo', assigneeAgentId: null });
  });

  it('never assigns an issue to an agent that is being deleted', async () => {
    for (let round = 0; round < 10; round += 1) {
      const agent = (
        await ctx.request({
          method: 'POST',
          url: '/api/agents',
          payload: { name: `Doomed ${round}`, role: 'x', adapter: { type: 'claude_cli' } },
        })
      ).json();
      const work = await issue({ title: `assign race ${round}` });
      await Promise.all([
        patch(work.key, { assigneeAgentId: agent.id }),
        ctx.request({ method: 'DELETE', url: `/api/agents/${agent.id}` }),
      ]);
      const agentGone =
        (await ctx.request({ method: 'GET', url: `/api/agents/${agent.id}` })).statusCode === 404;
      const assignee = (await ctx.request({ method: 'GET', url: `/api/issues/${work.key}` })).json()
        .assigneeAgentId;
      expect(agentGone && assignee === agent.id).toBe(false);
    }
  });

  it.each(['done', 'cancelled'])(
    'validates the effective assignee when reopening a %s issue',
    async (status) => {
      const agent = (
        await ctx.request({
          method: 'POST',
          url: '/api/agents',
          payload: { name: `Former worker ${status}`, role: 'x', adapter: { type: 'claude_cli' } },
        })
      ).json();
      const work = await issue({ title: 'reopen deleted assignee', assigneeAgentId: agent.id });
      const closed = await patch(work.key, { status });
      expect(closed.statusCode).toBe(200);
      expect(
        (await ctx.request({ method: 'DELETE', url: `/api/agents/${agent.id}` })).statusCode,
      ).toBe(204);

      const rejected = await patch(work.key, { status: 'todo' });
      expect(rejected.statusCode).toBe(422);
      expect(rejected.json()).toMatchObject({
        error: 'unprocessable',
        message: 'cannot reopen: the assigned agent no longer exists; reassign it',
      });
      expect(
        (await ctx.request({ method: 'GET', url: `/api/issues/${work.key}` })).json(),
      ).toMatchObject({
        status,
        assigneeAgentId: agent.id,
        closedAt: closed.json().closedAt,
      });

      const replacement = (
        await ctx.request({
          method: 'POST',
          url: '/api/agents',
          payload: { name: `Replacement ${status}`, role: 'x', adapter: { type: 'claude_cli' } },
        })
      ).json();
      for (const assigneeAgentId of [replacement.id, null]) {
        const reopened = await patch(work.key, { status: 'todo', assigneeAgentId });
        expect(reopened.statusCode).toBe(200);
        expect(reopened.json()).toMatchObject({ status: 'todo', assigneeAgentId, closedAt: null });
        expect((await patch(work.key, { status })).statusCode).toBe(200);
        if (assigneeAgentId !== null) {
          expect(
            (await ctx.request({ method: 'DELETE', url: `/api/agents/${assigneeAgentId}` }))
              .statusCode,
          ).toBe(204);
        }
      }
    },
  );

  it('serializes reopening an assigned issue with deleting its agent', async () => {
    for (let round = 0; round < 10; round += 1) {
      const agent = (
        await ctx.request({
          method: 'POST',
          url: '/api/agents',
          payload: { name: `Reopen race ${round}`, role: 'x', adapter: { type: 'claude_cli' } },
        })
      ).json();
      const work = await issue({ title: `reopen race ${round}`, assigneeAgentId: agent.id });
      expect((await patch(work.key, { status: 'done' })).statusCode).toBe(200);
      const [deleted, reopened] = await Promise.all([
        ctx.request({ method: 'DELETE', url: `/api/agents/${agent.id}` }),
        patch(work.key, { status: 'todo' }),
      ]);
      expect([
        [204, 422],
        [409, 200],
      ]).toContainEqual([deleted.statusCode, reopened.statusCode]);
      const after = (await ctx.request({ method: 'GET', url: `/api/issues/${work.key}` })).json();
      const agentAfter = await ctx.request({ method: 'GET', url: `/api/agents/${agent.id}` });
      expect(after.assigneeAgentId).toBe(agent.id);
      expect(after.status).toBe(deleted.statusCode === 204 ? 'done' : 'todo');
      expect(agentAfter.statusCode).toBe(deleted.statusCode === 204 ? 404 : 200);
      expect(after.closedAt === null).toBe(after.status === 'todo');
    }
  });

  it('filters and paginates', async () => {
    const parent = await issue({ title: 'list parent', labels: ['epic'] });
    for (let i = 0; i < 5; i += 1) {
      await issue({ title: `list child ${i}`, parentId: parent.id });
    }
    await patch(parent.key, { status: 'in_progress' });

    const children = (
      await ctx.request({ method: 'GET', url: `/api/issues?parentId=${parent.id}&limit=2` })
    ).json();
    expect(children.items).toHaveLength(2);
    expect(children.nextCursor).toBe(children.items[1].id);

    const rest = (
      await ctx.request({
        method: 'GET',
        url: `/api/issues?parentId=${parent.id}&limit=10&after=${children.nextCursor}`,
      })
    ).json();
    expect(rest.items).toHaveLength(3);
    expect(rest.nextCursor).toBeNull();

    const inProgress = (
      await ctx.request({
        method: 'GET',
        url: `/api/issues?projectId=${projectId}&status=in_progress,in_review`,
      })
    ).json();
    expect(inProgress.items.map((item: IssueBody) => item.key)).toEqual([parent.key]);

    const bad = await ctx.request({ method: 'GET', url: '/api/issues?status=finished' });
    expect(bad.statusCode).toBe(400);
  });

  it('searches by key prefix or title text, treating the query literally', async () => {
    const target = await issue({ title: 'Searchable (exact) widget' });
    await issue({ title: 'something else' });
    const search = async (q: string): Promise<string[]> =>
      (await ctx.request({ method: 'GET', url: `/api/issues?q=${encodeURIComponent(q)}` }))
        .json()
        .items.map((item: IssueBody) => item.key);

    expect(await search('(EXACT) widget')).toEqual([target.key]);
    expect(await search(target.key.toLowerCase())).toContain(target.key);
    expect(await search('.*')).toEqual([]);
    expect((await ctx.request({ method: 'GET', url: '/api/issues?q=' })).statusCode).toBe(400);
  });
});
