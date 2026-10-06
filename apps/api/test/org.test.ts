import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';

const claude = { type: 'claude_cli', model: 'opus' } as const;

describe('org lead, agent links and layout', () => {
  let ctx: TestContext;

  const agent = async (name: string, extra: Record<string, unknown> = {}) => {
    const response = await ctx.request({
      method: 'POST',
      url: '/api/agents',
      payload: { name, role: name.toLowerCase(), adapter: claude, ...extra },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string; reportsTo: string | null };
  };
  const link = (from: string, to: string, type: 'delegates' | 'reports' = 'delegates') =>
    ctx.request({ method: 'POST', url: '/api/agent-links', payload: { from, to, type } });
  const setLead = (agentId: string) =>
    ctx.request({ method: 'PUT', url: '/api/org/lead', payload: { agentId } });
  const getOrg = async () => (await ctx.request({ method: 'GET', url: '/api/org' })).json();
  const getAgent = async (id: string) =>
    (await ctx.request({ method: 'GET', url: `/api/agents/${id}` })).json();

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('bootstraps the only undelegated agent as lead and persists it', async () => {
    expect(await getOrg()).toMatchObject({ leadAgentId: null, leadCandidates: [] });
    const ceo = await agent('CEO');
    await agent('CTO', { reportsTo: ceo.id });

    const org = await getOrg();
    expect(org).toMatchObject({ leadAgentId: ceo.id, lead: { name: 'CEO' }, leadCandidates: [] });
    const stored = await ctx.database.collections.org.findOne({ _id: 'org' });
    expect(stored?.leadAgentId?.toHexString()).toBe(ceo.id);
  });

  it('leaves the lead unset with several candidates until the board picks one', async () => {
    const a = await agent('Alpha');
    const b = await agent('Beta');
    const org = await getOrg();
    expect(org.leadAgentId).toBeNull();
    expect(org.leadCandidates.map((item: { name: string }) => item.name)).toEqual([
      'Alpha',
      'Beta',
    ]);

    expect((await setLead('0123456789abcdef01234567')).statusCode).toBe(422);
    const picked = await setLead(b.id);
    expect(picked.statusCode).toBe(200);
    expect(picked.json()).toMatchObject({ leadAgentId: b.id, leadCandidates: [] });

    expect((await link(a.id, b.id)).statusCode).toBe(422);
    expect((await link(b.id, a.id)).statusCode).toBe(201);
    const refused = await setLead(a.id);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().message).toMatch(/remove the delegation links from Beta/);
  });

  it('rejects deleting the lead while other agents exist, but not the last agent', async () => {
    const ceo = await agent('CEO');
    const other = await agent('Other');
    expect((await setLead(ceo.id)).statusCode).toBe(200);

    const blocked = await ctx.request({ method: 'DELETE', url: `/api/agents/${ceo.id}` });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toMatch(/set another lead first/);

    expect((await setLead(other.id)).statusCode).toBe(200);
    expect((await ctx.request({ method: 'DELETE', url: `/api/agents/${ceo.id}` })).statusCode).toBe(
      204,
    );
    expect(
      (await ctx.request({ method: 'DELETE', url: `/api/agents/${other.id}` })).statusCode,
    ).toBe(204);
    expect((await getOrg()).leadAgentId).toBeNull();
  });

  it('validates links: duplicates, self-links, unknown agents and delegation cycles', async () => {
    const a = await agent('A');
    const b = await agent('B');
    const c = await agent('C');

    expect((await link(a.id, b.id)).statusCode).toBe(201);
    expect((await link(a.id, b.id)).statusCode).toBe(409);
    expect((await link(a.id, a.id)).statusCode).toBe(422);
    expect((await link(a.id, '0123456789abcdef01234567')).statusCode).toBe(422);
    expect((await link(a.id, b.id, 'oversees' as 'reports')).statusCode).toBe(400);
    expect((await link(b.id, c.id)).statusCode).toBe(201);

    const cycle = await link(c.id, a.id);
    expect(cycle.statusCode).toBe(422);
    expect(cycle.json().message).toBe('delegation would create a cycle: C -> A -> B -> C');
    expect(cycle.json().details.cycle).toEqual([c.id, a.id, b.id, c.id]);

    expect((await link(c.id, a.id, 'reports')).statusCode).toBe(201);
    expect((await link(a.id, c.id, 'reports')).statusCode).toBe(201);
  });

  it('never lets concurrent link creation close a delegation cycle', async () => {
    for (let round = 0; round < 8; round += 1) {
      const a = await agent(`Race A${round}`);
      const b = await agent(`Race B${round}`);
      const c = await agent(`Race C${round}`);
      expect((await link(a.id, b.id)).statusCode).toBe(201);
      const results = await Promise.all([link(b.id, c.id), link(c.id, a.id)]);
      expect(results.map((response) => response.statusCode).sort()).toEqual([201, 422]);
    }
  });

  it('serves the graph with positions and stores the layout', async () => {
    const ceo = await agent('CEO', { adapter: { type: 'claude_cli', model: 'opus' } });
    const dev = await agent('Dev', { reportsTo: ceo.id });
    await setLead(ceo.id);

    const layout = await ctx.request({
      method: 'PUT',
      url: '/api/org/layout',
      payload: { positions: [{ agentId: ceo.id, x: 10.5, y: -20 }] },
    });
    expect(layout.statusCode).toBe(204);
    const unknown = await ctx.request({
      method: 'PUT',
      url: '/api/org/layout',
      payload: { positions: [{ agentId: '0123456789abcdef01234567', x: 0, y: 0 }] },
    });
    expect(unknown.statusCode).toBe(422);
    const outOfBounds = await ctx.request({
      method: 'PUT',
      url: '/api/org/layout',
      payload: { positions: [{ agentId: ceo.id, x: 1e9, y: 0 }] },
    });
    expect(outOfBounds.statusCode).toBe(400);

    const graph = (await ctx.request({ method: 'GET', url: '/api/org-graph' })).json();
    expect(graph.leadAgentId).toBe(ceo.id);
    expect(graph.agents).toEqual([
      expect.objectContaining({
        id: ceo.id,
        name: 'CEO',
        adapterType: 'claude_cli',
        model: 'opus',
        position: { x: 10.5, y: -20 },
      }),
      expect.objectContaining({ id: dev.id, model: 'opus', position: null }),
    ]);
    expect(
      graph.links.map((item: { from: string; to: string; type: string }) => [
        item.from,
        item.to,
        item.type,
      ]),
    ).toEqual([
      [ceo.id, dev.id, 'delegates'],
      [dev.id, ceo.id, 'reports'],
    ]);
  });

  it('keeps reportsTo as a derived compatibility field', async () => {
    const m1 = await agent('M1');
    const m2 = await agent('M2');
    const worker = await agent('Worker', { reportsTo: m1.id });
    expect(worker.reportsTo).toBe(m1.id);

    expect((await link(m2.id, worker.id)).statusCode).toBe(201);
    expect((await getAgent(worker.id)).reportsTo).toBeNull();
    const chart = (await ctx.request({ method: 'GET', url: '/api/org-chart' })).json();
    expect(chart.roots.map((node: { name: string }) => node.name)).toEqual(['M1', 'M2', 'Worker']);

    const patched = await ctx.request({
      method: 'PATCH',
      url: `/api/agents/${worker.id}`,
      payload: { reportsTo: m2.id },
    });
    expect(patched.json().reportsTo).toBe(m2.id);
    const links = await ctx.database.collections.agentLinks.find().toArray();
    expect(
      links.map((item) => [item.from.toHexString(), item.to.toHexString(), item.type]).sort(),
    ).toEqual(
      [
        [m2.id, worker.id, 'delegates'],
        [worker.id, m2.id, 'reports'],
      ].sort(),
    );

    const lead = await setLead(m1.id);
    expect(lead.statusCode).toBe(200);
    const leadWithManager = await ctx.request({
      method: 'PATCH',
      url: `/api/agents/${m1.id}`,
      payload: { reportsTo: m2.id },
    });
    expect(leadWithManager.statusCode).toBe(422);
  });

  it('deletes links, and removes all links and the position of a deleted agent', async () => {
    const a = await agent('A');
    const b = await agent('B');
    const c = await agent('C');
    const ab = (await link(a.id, b.id)).json();
    await link(b.id, c.id);
    await link(c.id, b.id, 'reports');
    await ctx.request({
      method: 'PUT',
      url: '/api/org/layout',
      payload: { positions: [{ agentId: b.id, x: 1, y: 2 }] },
    });

    expect(
      (await ctx.request({ method: 'DELETE', url: `/api/agent-links/${ab.id}` })).statusCode,
    ).toBe(204);
    expect(
      (await ctx.request({ method: 'DELETE', url: `/api/agent-links/${ab.id}` })).statusCode,
    ).toBe(404);
    expect((await getAgent(c.id)).reportsTo).toBe(b.id);

    expect((await ctx.request({ method: 'DELETE', url: `/api/agents/${b.id}` })).statusCode).toBe(
      204,
    );
    expect(await ctx.database.collections.agentLinks.countDocuments()).toBe(0);
    expect(await ctx.database.collections.orgLayout.countDocuments()).toBe(0);
    expect((await getAgent(c.id)).reportsTo).toBeNull();
  });
});
