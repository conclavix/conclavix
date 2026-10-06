import { ObjectId } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';
import { createFixture, type Fixture } from './scheduler-helpers.js';

describe('project planning by the lead', () => {
  let ctx: TestContext;
  let fx: Fixture;

  const createProject = (payload: Record<string, unknown>) =>
    ctx.request({ method: 'POST', url: '/api/projects', payload });

  beforeEach(async () => {
    ctx = await createTestContext();
    fx = await createFixture(ctx);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await ctx.close();
  });

  it.each(['lead lookup', 'issue insert', 'wake request'])(
    'rolls back creation after a failed %s and allows retrying the same key',
    async (failure) => {
      const lead = await fx.agent();
      const { collections } = ctx.database;
      const error = new Error('Planning temporarily unavailable');
      if (failure === 'lead lookup') {
        vi.spyOn(collections.org, 'findOne').mockRejectedValueOnce(error);
      } else if (failure === 'issue insert') {
        vi.spyOn(collections.issues, 'insertOne').mockRejectedValueOnce(error);
      } else {
        vi.spyOn(collections.wakes, 'updateOne').mockRejectedValueOnce(error);
      }

      const payload = { key: 'RETRY', name: 'Retry planning' };
      const failed = await createProject(payload);
      expect(failed.statusCode).toBe(500);
      expect(await collections.projects.countDocuments({ key: payload.key })).toBe(0);
      expect(await collections.issues.countDocuments()).toBe(0);
      expect(await collections.counters.countDocuments()).toBe(0);
      expect(await collections.wakes.countDocuments()).toBe(0);

      const retried = await createProject(payload);
      expect(retried.statusCode).toBe(201);
      expect(retried.json().planning).toMatchObject({
        status: 'created',
        issueKey: 'RETRY-1',
        assigneeAgentId: lead.id,
      });
      expect(await collections.projects.countDocuments({ key: payload.key })).toBe(1);
      expect(await collections.issues.countDocuments()).toBe(1);
      expect(await collections.wakes.countDocuments()).toBe(1);
    },
  );

  it('skips planning when no lead is set', async () => {
    await fx.agent();
    await fx.agent();
    const response = await createProject({ key: 'NOLEAD', name: 'No lead' });
    expect(response.statusCode).toBe(201);
    expect(response.json().planning).toEqual({ status: 'skipped', reason: 'no_lead' });
    expect(await ctx.database.collections.issues.countDocuments()).toBe(0);
  });

  it('skips planning when autoPlan is false', async () => {
    await fx.agent();
    const response = await createProject({ key: 'MANUAL', name: 'Manual', autoPlan: false });
    expect(response.json().planning).toEqual({ status: 'skipped', reason: 'disabled' });
    expect(await ctx.database.collections.issues.countDocuments()).toBe(0);
  });

  it('assigns a planning issue to the lead and wakes it through the normal gates', async () => {
    const lead = await fx.agent({ name: 'CEO', role: 'ceo' });
    await fx.agent();
    expect(
      (await ctx.request({ method: 'PUT', url: '/api/org/lead', payload: { agentId: lead.id } }))
        .statusCode,
    ).toBe(200);

    const response = await createProject({
      key: 'SHOP',
      name: 'Webshop',
      description: 'Sell coffee online.',
    });
    expect(response.statusCode).toBe(201);
    const { planning } = response.json();
    expect(planning).toMatchObject({
      status: 'created',
      issueKey: 'SHOP-1',
      assigneeAgentId: lead.id,
    });

    const issue = (
      await ctx.request({ method: 'GET', url: `/api/issues/${planning.issueKey}` })
    ).json();
    expect(issue).toMatchObject({
      title: 'Plan project Webshop',
      parentId: null,
      assigneeAgentId: lead.id,
      status: 'todo',
      labels: ['planning'],
      delegatedBy: null,
    });
    expect(issue.description).toContain('Sell coffee online.');
    expect(issue.description).toContain('create_issue');

    const wake = await ctx.database.collections.wakes.findOne({ processedAt: null });
    expect(wake).toMatchObject({ agentId: new ObjectId(lead.id), reason: 'assigned' });
    expect(await fx.scheduler.processPendingWakes()).toEqual({ run: 1, skip: 0, defer: 0 });
    expect(fx.dispatcher.runs.map((run) => run.agentId.toHexString())).toEqual([lead.id]);
  });

  it('does not run the planning issue when the lead is paused', async () => {
    const lead = await fx.agent({ name: 'CEO', role: 'ceo' });
    await fx.agent();
    await ctx.request({ method: 'PUT', url: '/api/org/lead', payload: { agentId: lead.id } });
    await ctx.request({
      method: 'PATCH',
      url: `/api/agents/${lead.id}`,
      payload: { status: 'paused' },
    });

    const response = await createProject({ key: 'PAUSE', name: 'Paused' });
    expect(response.json().planning.status).toBe('created');
    expect(await fx.scheduler.processPendingWakes()).toEqual({ run: 0, skip: 1, defer: 0 });
    const wake = await ctx.database.collections.wakes.findOne({});
    expect(wake?.skipReason).toBe('agent_paused');
  });
});
