import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';

const claude = { type: 'claude_cli', model: 'opus' } as const;

describe('agents and org chart', () => {
  let ctx: TestContext;

  /** Submit an agent creation request with a default Claude adapter. */
  const createAgent = async (payload: Record<string, unknown>) =>
    ctx.request({ method: 'POST', url: '/api/agents', payload: { adapter: claude, ...payload } });

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('creates an agent with default limits', async () => {
    const response = await createAgent({ name: 'CEO', role: 'ceo' });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      name: 'CEO',
      reportsTo: null,
      status: 'active',
      limits: { maxIdleRunsPerIssue: 2, maxCostPerRunUsd: 2, maxCostPerDayUsd: 20 },
    });
  });

  it('accepts the former limit name maxRunsPerIssuePerHour as the idle-run limit', async () => {
    const created = await createAgent({
      name: 'Legacy client',
      role: 'x',
      limits: { maxRunsPerIssuePerHour: 6, maxCostPerRunUsd: 1, maxCostPerDayUsd: 5 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().limits).toEqual({
      maxIdleRunsPerIssue: 6,
      maxCostPerRunUsd: 1,
      maxCostPerDayUsd: 5,
    });
    const both = await ctx.request({
      method: 'PATCH',
      url: `/api/agents/${created.json().id}`,
      payload: {
        limits: {
          maxRunsPerIssuePerHour: 9,
          maxIdleRunsPerIssue: 3,
          maxCostPerRunUsd: 1,
          maxCostPerDayUsd: 5,
        },
      },
    });
    expect(both.statusCode).toBe(200);
    expect(both.json().limits.maxIdleRunsPerIssue).toBe(3);
    const invalid = await ctx.request({
      method: 'PATCH',
      url: `/api/agents/${created.json().id}`,
      payload: { limits: { maxRunsPerIssuePerHour: 0, maxCostPerRunUsd: 1, maxCostPerDayUsd: 5 } },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('builds the org chart from reportsTo', async () => {
    const ceo = (await createAgent({ name: 'Chief', role: 'ceo' })).json();
    const cto = (await createAgent({ name: 'CTO', role: 'cto', reportsTo: ceo.id })).json();
    await createAgent({ name: 'Backend', role: 'engineer', reportsTo: cto.id });

    const chart = (await ctx.request({ method: 'GET', url: '/api/org-chart' })).json();
    const chief = chart.roots.find((node: { name: string }) => node.name === 'Chief');
    expect(chief.reports.map((node: { name: string }) => node.name)).toEqual(['CTO']);
    expect(chief.reports[0].reports.map((node: { name: string }) => node.name)).toEqual([
      'Backend',
    ]);
  });

  it('rejects a reportsTo that would create a cycle', async () => {
    const a = (await createAgent({ name: 'Loop A', role: 'x' })).json();
    const b = (await createAgent({ name: 'Loop B', role: 'x', reportsTo: a.id })).json();
    const c = (await createAgent({ name: 'Loop C', role: 'x', reportsTo: b.id })).json();

    const cycle = await ctx.request({
      method: 'PATCH',
      url: `/api/agents/${a.id}`,
      payload: { reportsTo: c.id },
    });
    expect(cycle.statusCode).toBe(422);

    const self = await ctx.request({
      method: 'PATCH',
      url: `/api/agents/${a.id}`,
      payload: { reportsTo: a.id },
    });
    expect(self.statusCode).toBe(422);
  });

  it('never lets concurrent updates close a cycle', async () => {
    for (let round = 0; round < 10; round += 1) {
      const a = (await createAgent({ name: `Race A${round}`, role: 'x' })).json();
      const b = (await createAgent({ name: `Race B${round}`, role: 'x' })).json();

      const results = await Promise.all([
        ctx.request({ method: 'PATCH', url: `/api/agents/${a.id}`, payload: { reportsTo: b.id } }),
        ctx.request({ method: 'PATCH', url: `/api/agents/${b.id}`, payload: { reportsTo: a.id } }),
      ]);

      expect(results.map((response) => response.statusCode).sort()).toEqual([200, 422]);
    }
  });

  it('rejects a reportsTo pointing to a missing agent', async () => {
    const response = await createAgent({
      name: 'Orphan',
      role: 'x',
      reportsTo: '0123456789abcdef01234567',
    });
    expect(response.statusCode).toBe(422);
  });

  it('treats agent names as unique regardless of case', async () => {
    await createAgent({ name: 'Designer', role: 'design' });
    const duplicate = await createAgent({ name: 'designer', role: 'design' });
    expect(duplicate.statusCode).toBe(409);
  });

  it('refuses a raw API key in the adapter config', async () => {
    const response = await createAgent({
      name: 'HTTP Agent',
      role: 'x',
      adapter: {
        type: 'openai_http',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5',
        apiKeySecret: 'sk-proj-abc123',
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('deletes an agent with reports together with its links', async () => {
    const manager = (await createAgent({ name: 'Manager', role: 'lead' })).json();
    const member = (await createAgent({ name: 'Member', role: 'x', reportsTo: manager.id })).json();
    expect(member.reportsTo).toBe(manager.id);

    const deleted = await ctx.request({ method: 'DELETE', url: `/api/agents/${manager.id}` });
    expect(deleted.statusCode).toBe(204);
    const gone = await ctx.request({ method: 'GET', url: `/api/agents/${manager.id}` });
    expect(gone.statusCode).toBe(404);
    const after = (await ctx.request({ method: 'GET', url: `/api/agents/${member.id}` })).json();
    expect(after.reportsTo).toBeNull();
  });

  it('pauses an agent', async () => {
    const agent = (await createAgent({ name: 'Pausable', role: 'x' })).json();
    const response = await ctx.request({
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      payload: { status: 'paused' },
    });
    expect(response.json().status).toBe('paused');
  });
});
