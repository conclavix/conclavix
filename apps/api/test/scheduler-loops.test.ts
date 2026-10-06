import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';
import { createFixture, type Fixture } from './scheduler-helpers.js';
import { PROCESSED_WAKE_RETENTION_SECONDS } from '../src/db/indexes.js';

describe('scheduler loops, heartbeats and concurrency', () => {
  let ctx: TestContext;
  let fx: Fixture;

  const runOnce = async (agentId: string, issueId: string, beforeFinish?: () => Promise<void>) => {
    await ctx.request({ method: 'POST', url: `/api/agents/${agentId}/wake`, payload: { issueId } });
    await fx.scheduler.processPendingWakes();
    const run = fx.dispatcher.runs.at(-1);
    if (!run) throw new Error('expected a run');
    await beforeFinish?.();
    await fx.scheduler.finishRun(run._id, { status: 'succeeded', costUsd: 0.01 });
  };

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  beforeEach(async () => {
    await ctx.database.collections.wakes.deleteMany({});
    fx = await createFixture(ctx);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('pauses an agent after three runs without progress and tells the board', async () => {
    const agent = await fx.agent({
      limits: { maxIdleRunsPerIssue: 2, maxCostPerRunUsd: 1, maxCostPerDayUsd: 10 },
    });
    const issue = await fx.issue({ title: 'stuck', assigneeAgentId: agent.id, status: 'backlog' });
    await fx.patch(issue.key, { status: 'todo' });
    await ctx.database.collections.wakes.deleteMany({});

    for (let i = 0; i < 3; i += 1) {
      await runOnce(agent.id, issue.id);
    }
    const after = (await ctx.request({ method: 'GET', url: `/api/agents/${agent.id}` })).json();
    expect(after.status).toBe('paused');
    const comments = (
      await ctx.request({ method: 'GET', url: `/api/issues/${issue.key}/comments` })
    ).json();
    expect(comments.items.at(-1)).toMatchObject({ author: { type: 'system' } });
    expect(comments.items.at(-1).body).toMatch(/Agent paused/);
  });

  it('does not pause an agent that makes progress', async () => {
    const agent = await fx.agent({
      limits: { maxIdleRunsPerIssue: 2, maxCostPerRunUsd: 1, maxCostPerDayUsd: 10 },
    });
    const issue = await fx.issue({ title: 'moving', assigneeAgentId: agent.id });
    await ctx.database.collections.wakes.deleteMany({});
    await ctx.database.collections.issues.updateOne(
      { _id: new ObjectId(issue.id) },
      { $set: { checkoutRunId: null } },
    );

    for (let i = 0; i < 4; i += 1) {
      await runOnce(agent.id, issue.id, async () => {
        await ctx.request({
          method: 'PUT',
          url: `/api/issues/${issue.key}/documents/notes`,
          payload: i === 0 ? { body: `n${i}` } : { body: `n${i}`, baseRevision: i },
        });
      });
    }
    expect(
      (await ctx.request({ method: 'GET', url: `/api/agents/${agent.id}` })).json().status,
    ).toBe('active');
  });

  it('sweeps heartbeats only for actionable, idle, overdue issues', async () => {
    const agent = await fx.agent();
    const overdue = await fx.issue({ title: 'overdue', assigneeAgentId: agent.id });
    const fresh = await fx.issue({ title: 'fresh', assigneeAgentId: agent.id });
    await fx.issue({ title: 'backlog', assigneeAgentId: agent.id, status: 'backlog' });
    await fx.issue({ title: 'unassigned' });
    await fx.scheduler.processPendingWakes();
    for (const run of fx.dispatcher.runs) {
      await fx.scheduler.finishRun(run._id, { status: 'succeeded', costUsd: 0 });
    }
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await ctx.database.collections.issues.updateOne(
      { _id: new ObjectId(overdue.id) },
      { $set: { lastRunAt: twoHoursAgo } },
    );

    expect(await fx.scheduler.sweepHeartbeats()).toBe(1);
    const wake = await ctx.database.collections.wakes.findOne({ processedAt: null });
    expect(wake?.issueId.toHexString()).toBe(overdue.id);
    expect(wake?.reason).toBe('heartbeat');
    expect(fresh.id).not.toBe(overdue.id);
  });

  it('creates no heartbeat wakes for a blocked issue but wakes it once unblocked', async () => {
    const agent = await fx.agent();
    const blocker = await fx.issue({ title: 'blocker' });
    const blocked = await fx.issue({
      title: 'blocked',
      assigneeAgentId: agent.id,
      blockedBy: [blocker.id],
    });
    const runsOfBlocked = () =>
      fx.dispatcher.runs.filter((run) => run.issueId.toHexString() === blocked.id).length;
    await fx.scheduler.processPendingWakes();
    expect(runsOfBlocked()).toBe(0);
    const wakesOf = () =>
      ctx.database.collections.wakes.countDocuments({ issueId: new ObjectId(blocked.id) });
    const initial = await wakesOf();

    for (let sweep = 0; sweep < 3; sweep += 1) {
      await fx.scheduler.sweepHeartbeats();
      await fx.scheduler.processPendingWakes();
    }
    expect(await wakesOf()).toBe(initial);

    await fx.patch(blocker.key, { status: 'done' });
    const wake = await ctx.database.collections.wakes.findOne({
      issueId: new ObjectId(blocked.id),
      processedAt: null,
    });
    expect(wake?.reason).toBe('unblocked');
    await fx.scheduler.processPendingWakes();
    expect(runsOfBlocked()).toBe(1);
  });

  it('creates no heartbeat wakes for a paused agent, keeps explicit wakes and resumes', async () => {
    const agent = await fx.agent();
    const issue = await fx.issue({ title: 'paused work', assigneeAgentId: agent.id });
    const issueId = new ObjectId(issue.id);
    await ctx.database.collections.wakes.deleteMany({ issueId });
    await ctx.database.collections.issues.updateOne(
      { _id: issueId },
      { $set: { lastRunAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } },
    );
    await ctx.request({
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      payload: { status: 'paused' },
    });
    const wakesOf = () => ctx.database.collections.wakes.countDocuments({ issueId });

    for (let sweep = 0; sweep < 3; sweep += 1) {
      await fx.scheduler.sweepHeartbeats();
      await fx.scheduler.processPendingWakes();
    }
    expect(await wakesOf()).toBe(0);

    await ctx.request({
      method: 'POST',
      url: `/api/agents/${agent.id}/wake`,
      payload: { issueId: issue.id },
    });
    await fx.scheduler.processPendingWakes();
    expect(await ctx.database.collections.wakes.findOne({ issueId })).toMatchObject({
      reason: 'manual',
      skipReason: 'agent_paused',
    });

    await ctx.request({
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      payload: { status: 'active' },
    });
    await fx.scheduler.sweepHeartbeats();
    expect(
      await ctx.database.collections.wakes.findOne({ issueId, processedAt: null }),
    ).toMatchObject({ reason: 'heartbeat' });
  });

  it('creates no heartbeat wakes for issues of a deleted agent', async () => {
    const issue = await fx.issue({ title: 'orphaned' });
    const issueId = new ObjectId(issue.id);
    await ctx.database.collections.issues.updateOne(
      { _id: issueId },
      { $set: { assigneeAgentId: new ObjectId(), status: 'todo', lastRunAt: null } },
    );
    await fx.scheduler.sweepHeartbeats();
    expect(await ctx.database.collections.wakes.countDocuments({ issueId })).toBe(0);
  });

  it('expires processed wakes through a TTL index on processedAt', async () => {
    const indexes = await ctx.database.collections.wakes.listIndexes().toArray();
    const ttl = indexes.find((index) => index.expireAfterSeconds !== undefined);
    expect(ttl?.key).toEqual({ processedAt: 1 });
    expect(ttl?.expireAfterSeconds).toBe(PROCESSED_WAKE_RETENTION_SECONDS);
  });

  it('never creates two runs for one issue when schedulers race', async () => {
    const agent = await fx.agent();
    const issues = [];
    for (let i = 0; i < 10; i += 1) {
      issues.push(await fx.issue({ title: `race ${i}`, assigneeAgentId: agent.id }));
    }
    const other = await createFixture(ctx);
    await Promise.all([fx.scheduler.processPendingWakes(), other.scheduler.processPendingWakes()]);

    const runs = await ctx.database.collections.runs
      .find({ issueId: { $in: issues.map((issue) => new ObjectId(issue.id)) } })
      .toArray();
    expect(runs).toHaveLength(10);
    expect(new Set(runs.map((run) => run.issueId.toHexString())).size).toBe(10);
    expect(fx.dispatcher.runs.length + other.dispatcher.runs.length).toBe(10);
  });

  it('lists runs and validates manual wakes', async () => {
    const agent = await fx.agent();
    const issue = await fx.issue({ title: 'listed', assigneeAgentId: agent.id });
    await fx.scheduler.processPendingWakes();
    const list = (
      await ctx.request({ method: 'GET', url: `/api/runs?agentId=${agent.id}` })
    ).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      issueId: issue.id,
      status: 'queued',
      reason: 'assigned',
    });

    const unassigned = await fx.issue({ title: 'nobody' });
    const refused = await ctx.request({
      method: 'POST',
      url: `/api/agents/${agent.id}/wake`,
      payload: { issueId: unassigned.id },
    });
    expect(refused.statusCode).toBe(422);
  });
});
