import { ObjectId } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';
import { callTool, connectAgent, startRunFor } from './mcp-helpers.js';
import { createFixture, type Fixture, issueRun } from './scheduler-helpers.js';

type Ref = { id: string; key: string };

describe('reports links that wake their target', () => {
  let ctx: TestContext;
  let fx: Fixture;
  let baseUrl: string;
  let lead: { id: string };
  let integrator: { id: string };
  let reviewer: { id: string };
  let plan: Ref;
  let reviewLink: { id: string; wakeOnReport: boolean };

  const link = async (
    from: string,
    to: string,
    type: 'delegates' | 'reports',
    extra: Record<string, unknown> = {},
  ) => {
    const response = await ctx.request({
      method: 'POST',
      url: '/api/agent-links',
      payload: { from, to, type, ...extra },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string; wakeOnReport: boolean };
  };
  const setWake = (id: string, wakeOnReport: unknown) =>
    ctx.request({ method: 'PATCH', url: `/api/agent-links/${id}`, payload: { wakeOnReport } });
  const pendingWakesFor = (agentId: string) =>
    ctx.database.collections.wakes
      .find({ agentId: new ObjectId(agentId), processedAt: null })
      .toArray();
  const notificationsFor = (agentId: string) =>
    ctx.database.collections.notifications.find({ agentId: new ObjectId(agentId) }).toArray();

  /** Lead delegates integration from its plan; the integrator delegates the review below it. */
  async function delegateReview(): Promise<{ integration: Ref; review: Ref }> {
    const leadRun = await startRunFor(ctx, fx, plan.id);
    const leadClient = await connectAgent(baseUrl, leadRun.token);
    const integration = (
      await callTool(leadClient, 'create_subissue', {
        title: 'Integrate',
        assigneeAgentId: integrator.id,
      })
    ).data as Ref;
    await leadClient.close();
    await fx.scheduler.finishRun(leadRun.run._id, { status: 'succeeded', costUsd: 0 });

    const integratorRun = await startRunFor(ctx, fx, integration.id);
    const integratorClient = await connectAgent(baseUrl, integratorRun.token);
    const review = (
      await callTool(integratorClient, 'create_subissue', {
        title: 'Review',
        assigneeAgentId: reviewer.id,
      })
    ).data as Ref;
    await integratorClient.close();
    await fx.scheduler.finishRun(integratorRun.run._id, { status: 'succeeded', costUsd: 0 });
    await fx.scheduler.processPendingWakes();
    return { integration, review };
  }

  beforeEach(async () => {
    ctx = await createTestContext();
    baseUrl = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    fx = await createFixture(ctx);
    lead = await fx.agent({ name: 'Lead', role: 'ceo' });
    integrator = await fx.agent({ name: 'Integrator' });
    reviewer = await fx.agent({ name: 'Reviewer' });
    await link(lead.id, integrator.id, 'delegates');
    await link(integrator.id, reviewer.id, 'delegates');
    await link(integrator.id, lead.id, 'reports');
    await link(reviewer.id, integrator.id, 'reports');
    reviewLink = await link(reviewer.id, lead.id, 'reports');
    plan = await fx.issue({ title: 'Plan', assigneeAgentId: lead.id });
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('only notifies the report target by default', async () => {
    expect(reviewLink.wakeOnReport).toBe(false);
    const { integration, review } = await delegateReview();
    await fx.patch(review.key, { status: 'done' });

    expect(await pendingWakesFor(integrator.id)).toEqual([
      expect.objectContaining({
        issueId: new ObjectId(integration.id),
        reason: 'delegation_closed',
      }),
    ]);
    expect(await pendingWakesFor(lead.id)).toHaveLength(0);
    expect(await notificationsFor(lead.id)).toEqual([
      expect.objectContaining({ issueId: new ObjectId(review.id) }),
    ]);
  });

  it('wakes the target on its own issue above the closed one when wakeOnReport is on', async () => {
    expect((await setWake(reviewLink.id, true)).json()).toMatchObject({ wakeOnReport: true });
    const { integration, review } = await delegateReview();
    await fx.patch(review.key, { status: 'done' });

    expect(await pendingWakesFor(lead.id)).toEqual([
      expect.objectContaining({ issueId: new ObjectId(plan.id), reason: 'report_closed' }),
    ]);
    expect(await notificationsFor(lead.id)).toEqual([
      expect.objectContaining({ issueId: new ObjectId(review.id) }),
    ]);
    expect(await pendingWakesFor(integrator.id)).toEqual([
      expect.objectContaining({ issueId: new ObjectId(integration.id) }),
    ]);

    const before = fx.dispatcher.runs.length;
    await fx.scheduler.processPendingWakes();
    expect(
      fx.dispatcher.runs
        .slice(before)
        .map((run) => `${run.agentId.toHexString()}:${issueRun(run).issueId.toHexString()}`)
        .sort(),
    ).toEqual([`${integrator.id}:${integration.id}`, `${lead.id}:${plan.id}`].sort());
  });

  it('does not wake when the target has no actionable issue above, and never on the closed one', async () => {
    await setWake(reviewLink.id, true);
    const { review } = await delegateReview();
    await fx.patch(plan.key, { status: 'in_review' });
    await fx.patch(review.key, { status: 'done' });
    expect(await pendingWakesFor(lead.id)).toHaveLength(0);
    expect(await notificationsFor(lead.id)).toHaveLength(1);

    const loose = await fx.issue({ title: 'Lead also assigned here', assigneeAgentId: lead.id });
    await fx.scheduler.processPendingWakes();
    await fx.patch(review.key, { status: 'todo' });
    await fx.patch(review.key, { status: 'cancelled' });
    const wakes = await ctx.database.collections.wakes
      .find({ agentId: new ObjectId(lead.id), reason: 'report_closed' })
      .toArray();
    expect(wakes).toHaveLength(0);
    expect(wakes.some((wake) => wake.issueId.equals(new ObjectId(loose.id)))).toBe(false);
  });

  it('keeps the scheduler gates: an idle target backs off, a paused one is skipped', async () => {
    await setWake(reviewLink.id, true);
    const { review } = await delegateReview();
    await ctx.request({
      method: 'PATCH',
      url: `/api/agents/${lead.id}`,
      payload: { limits: { maxIdleRunsPerIssue: 1, maxCostPerRunUsd: 1, maxCostPerDayUsd: 5 } },
    });
    // The lead's last run on its plan changed nothing, so its next one waits for the backoff.
    await ctx.database.collections.runs.updateMany(
      { agentId: new ObjectId(lead.id), issueId: new ObjectId(plan.id) },
      { $set: { madeProgress: false, finishedAt: new Date() } },
    );
    await fx.patch(review.key, { status: 'done' });
    await fx.scheduler.processPendingWakes();
    const wake = await ctx.database.collections.wakes.findOne({
      agentId: new ObjectId(lead.id),
      reason: 'report_closed',
    });
    expect(wake).toMatchObject({ processedAt: null, deferReason: 'idle_backoff' });

    await ctx.request({
      method: 'PATCH',
      url: `/api/agents/${lead.id}`,
      payload: { status: 'paused' },
    });
    await fx.patch(review.key, { status: 'todo' });
    await fx.patch(review.key, { status: 'done' });
    const afterWindow = new Date(Date.now() + 61 * 60_000);
    await fx.scheduler.processPendingWakes(afterWindow);
    await fx.scheduler.processPendingWakes(afterWindow);
    const latest = await ctx.database.collections.wakes
      .find({ agentId: new ObjectId(lead.id), reason: 'report_closed' })
      .sort({ _id: -1 })
      .limit(1)
      .next();
    expect(latest?.skipReason).toBe('agent_paused');
    expect(
      await ctx.database.collections.runs.countDocuments({
        agentId: new ObjectId(lead.id),
        reason: 'report_closed',
      }),
    ).toBe(0);
  });

  it('wakes each target at most once per closure, so mutual wake links cannot loop', async () => {
    await setWake(reviewLink.id, true);
    const back = await link(lead.id, reviewer.id, 'reports', { wakeOnReport: true });
    expect(back.wakeOnReport).toBe(true);
    const { review } = await delegateReview();
    await fx.patch(review.key, { status: 'done' });
    await fx.scheduler.processPendingWakes();
    expect(await ctx.database.collections.wakes.countDocuments({ reason: 'report_closed' })).toBe(
      1,
    );
    expect(await pendingWakesFor(reviewer.id)).toHaveLength(0);
  });
});

describe('agent link options in the org API', () => {
  let ctx: TestContext;
  let a: { id: string };
  let b: { id: string };

  beforeEach(async () => {
    ctx = await createTestContext();
    const fx = await createFixture(ctx);
    a = await fx.agent({ name: 'A' });
    b = await fx.agent({ name: 'B' });
  });

  afterEach(async () => {
    await ctx.close();
  });

  const create = (payload: Record<string, unknown>) =>
    ctx.request({ method: 'POST', url: '/api/agent-links', payload });

  it('creates, toggles and returns wakeOnReport on reports links only', async () => {
    const rejected = await create({ from: a.id, to: b.id, type: 'delegates', wakeOnReport: true });
    expect(rejected.statusCode).toBe(422);
    const delegates = (await create({ from: a.id, to: b.id, type: 'delegates' })).json();
    expect(delegates.wakeOnReport).toBe(false);
    const reports = await create({ from: b.id, to: a.id, type: 'reports', wakeOnReport: true });
    expect(reports.statusCode).toBe(201);
    expect(reports.json()).toMatchObject({ type: 'reports', wakeOnReport: true });

    const off = await ctx.request({
      method: 'PATCH',
      url: `/api/agent-links/${reports.json().id}`,
      payload: { wakeOnReport: false },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ id: reports.json().id, wakeOnReport: false });

    const graph = (await ctx.request({ method: 'GET', url: '/api/org-graph' })).json();
    expect(
      graph.links.map((item: { type: string; wakeOnReport: boolean }) => [
        item.type,
        item.wakeOnReport,
      ]),
    ).toEqual([
      ['delegates', false],
      ['reports', false],
    ]);

    const onDelegates = await ctx.request({
      method: 'PATCH',
      url: `/api/agent-links/${delegates.id}`,
      payload: { wakeOnReport: true },
    });
    expect(onDelegates.statusCode).toBe(422);
    const invalid = await ctx.request({
      method: 'PATCH',
      url: `/api/agent-links/${reports.json().id}`,
      payload: { wakeOnReport: 'yes', type: 'delegates' },
    });
    expect(invalid.statusCode).toBe(400);
    const missing = await ctx.request({
      method: 'PATCH',
      url: `/api/agent-links/${new ObjectId().toHexString()}`,
      payload: { wakeOnReport: true },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('treats links stored before the option as not waking', async () => {
    const id = new ObjectId();
    await ctx.database.collections.agentLinks.insertOne({
      _id: id,
      from: new ObjectId(a.id),
      to: new ObjectId(b.id),
      type: 'reports',
      createdAt: new Date(),
    });
    const graph = (await ctx.request({ method: 'GET', url: '/api/org-graph' })).json();
    expect(graph.links).toEqual([
      expect.objectContaining({ id: id.toHexString(), wakeOnReport: false }),
    ]);
  });
});
