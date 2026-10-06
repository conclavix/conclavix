import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';

describe('listing issues by assignee', () => {
  let ctx: TestContext;
  let projectId: string;
  const agentIds: Record<string, string> = {};

  const post = async (url: string, payload: Record<string, unknown>) =>
    (await ctx.request({ method: 'POST', url, payload })).json();

  beforeAll(async () => {
    ctx = await createTestContext();
    projectId = (await post('/api/projects', { key: 'ASG', name: 'Assignees' })).id;
    for (const name of ['Alice', 'Bob']) {
      const agent = await post('/api/agents', {
        name,
        role: 'engineer',
        adapter: { type: 'claude_cli' },
      });
      agentIds[name] = agent.id;
    }
    await post('/api/issues', { projectId, title: 'a1', assigneeAgentId: agentIds['Alice'] });
    await post('/api/issues', { projectId, title: 'b1', assigneeAgentId: agentIds['Bob'] });
    await post('/api/issues', {
      projectId,
      title: 'a2',
      status: 'backlog',
      assigneeAgentId: agentIds['Alice'],
    });
    await post('/api/issues', { projectId, title: 'nobody' });
  });

  afterAll(async () => {
    await ctx.close();
  });

  const titles = async (query: string): Promise<string[]> => {
    const response = await ctx.request({ method: 'GET', url: `/api/issues?${query}` });
    expect(response.statusCode).toBe(200);
    return response.json().items.map((issue: { title: string }) => issue.title);
  };

  it('returns only the issues assigned to that agent', async () => {
    expect(await titles(`assigneeAgentId=${agentIds['Alice']}`)).toEqual(['a1', 'a2']);
    expect(await titles(`assigneeAgentId=${agentIds['Bob']}`)).toEqual(['b1']);
  });

  it('combines the assignee filter with a status filter', async () => {
    expect(await titles(`assigneeAgentId=${agentIds['Alice']}&status=todo,in_progress`)).toEqual([
      'a1',
    ]);
  });

  it('rejects a malformed assignee id', async () => {
    const response = await ctx.request({ method: 'GET', url: '/api/issues?assigneeAgentId=nope' });
    expect(response.statusCode).toBe(400);
  });
});
