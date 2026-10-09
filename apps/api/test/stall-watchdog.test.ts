import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sweepStalls } from '../src/modules/scheduler/stall-watchdog.js';
import { createTestContext, type TestContext } from './helpers.js';
import { createFixture, progressDuring, type Fixture } from './scheduler-helpers.js';

describe('stall watchdog', () => {
  let ctx: TestContext;
  let fx: Fixture;

  const later = () => new Date(Date.now() + 10 * 60_000);
  const pendingFor = (issueId: string) =>
    ctx.database.collections.wakes
      .find({ issueId: new ObjectId(issueId), processedAt: null })
      .toArray();

  /** An assigned issue whose first run finished, so nothing is pending for it. */
  const idleIssue = async (payload: Record<string, unknown> = {}) => {
    const agent = await fx.agent();
    const issue = await fx.issue({ title: 'work', assigneeAgentId: agent.id, ...payload });
    await fx.scheduler.processPendingWakes();
    const run = fx.dispatcher.runs.at(-1);
    if (run?.issueId?.toHexString() === issue.id) {
      // The run did its step; the watchdog only nudges after progress.
      await progressDuring(ctx, run);
      await fx.scheduler.finishRun(run._id, { status: 'succeeded', costUsd: 0 });
    }
    expect(await pendingFor(issue.id)).toHaveLength(0);
    return { agent, issue };
  };

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  beforeEach(async () => {
    await ctx.database.collections.wakes.deleteMany({});
    await ctx.database.collections.issues.updateMany({}, { $set: { status: 'cancelled' } });
    fx = await createFixture(ctx);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('wakes a stalled issue once and leaves it to the pending wake afterwards', async () => {
    const { agent, issue } = await idleIssue();
    expect(await fx.scheduler.sweepStalls(new Date())).toMatchObject({ woken: 0 });

    expect(await fx.scheduler.sweepStalls(later())).toMatchObject({ candidates: 1, woken: 1 });
    expect(await pendingFor(issue.id)).toEqual([
      expect.objectContaining({ agentId: new ObjectId(agent.id), reason: 'stall_watchdog' }),
    ]);
    expect(await fx.scheduler.sweepStalls(later())).toMatchObject({ woken: 0, pendingWake: 1 });
    expect(await pendingFor(issue.id)).toHaveLength(1);

    expect(await fx.scheduler.processPendingWakes()).toEqual({ run: 1, skip: 0, defer: 0 });
    expect(fx.dispatcher.runs.at(-1)).toMatchObject({ reason: 'stall_watchdog' });
  });

  it('leaves issues with an open sub-issue, an open blocker or a pending wake alone', async () => {
    const parent = await idleIssue();
    await fx.issue({ title: 'child', parentId: parent.issue.id });
    const blocker = await fx.issue({ title: 'blocker' });
    const blocked = await idleIssue({ blockedBy: [blocker.id] });
    await ctx.database.collections.wakes.deleteMany({});
    const waking = await idleIssue();
    await ctx.request({
      method: 'POST',
      url: `/api/issues/${waking.issue.key}/comments`,
      payload: { body: 'news' },
    });

    expect(await fx.scheduler.sweepStalls(later())).toMatchObject({
      candidates: 3,
      woken: 0,
      openSubIssues: 1,
      openBlockers: 1,
      pendingWake: 1,
    });
    expect(await pendingFor(parent.issue.id)).toHaveLength(0);
    expect(await pendingFor(blocked.issue.id)).toHaveLength(0);
  });

  it('leaves an issue with a running run alone', async () => {
    const agent = await fx.agent();
    const issue = await fx.issue({ title: 'busy', assigneeAgentId: agent.id });
    await fx.scheduler.processPendingWakes();
    expect(await fx.scheduler.sweepStalls(later())).toMatchObject({ candidates: 0, woken: 0 });
    expect(await pendingFor(issue.id)).toHaveLength(0);
  });

  it('ignores paused agents and in_review issues', async () => {
    const paused = await idleIssue();
    await ctx.request({
      method: 'PATCH',
      url: `/api/agents/${paused.agent.id}`,
      payload: { status: 'paused' },
    });
    const review = await idleIssue();
    await fx.patch(review.issue.key, { status: 'in_review' });

    expect(await fx.scheduler.sweepStalls(later())).toMatchObject({ candidates: 0, woken: 0 });
    expect(await pendingFor(paused.issue.id)).toHaveLength(0);
    expect(await pendingFor(review.issue.id)).toHaveLength(0);
  });

  it('leaves the issue to the heartbeat when one more idle run would reach the idle limit', async () => {
    const { agent, issue } = await idleIssue();
    await ctx.database.collections.runs.updateMany(
      { issueId: new ObjectId(issue.id) },
      { $set: { madeProgress: false } },
    );
    expect(await fx.scheduler.sweepStalls(later())).toMatchObject({ idle: 1, woken: 0 });

    await ctx.database.collections.runs.updateMany(
      { issueId: new ObjectId(issue.id) },
      { $set: { madeProgress: true } },
    );
    await ctx.request({
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      payload: { limits: { maxIdleRunsPerIssue: 1, maxCostPerRunUsd: 1, maxCostPerDayUsd: 5 } },
    });
    expect(await fx.scheduler.sweepStalls(later())).toMatchObject({ idle: 1, woken: 0 });
    expect(await pendingFor(issue.id)).toHaveLength(0);
  });

  it('filters before the per-sweep limit, so waiting issues cannot hide a stalled one', async () => {
    const waiting = await idleIssue();
    await fx.issue({ title: 'child', parentId: waiting.issue.id });
    const stalled = await idleIssue();
    expect(await sweepStalls(ctx.database.collections, 5, 1, later())).toMatchObject({
      openSubIssues: 1,
      woken: 1,
    });
    expect(await pendingFor(stalled.issue.id)).toHaveLength(1);
  });

  it('does nothing when switched off', async () => {
    await idleIssue();
    const off = await createFixture(ctx, { stallWatchdogMinutes: 0 });
    expect(await off.scheduler.sweepStalls(later())).toMatchObject({ candidates: 0, woken: 0 });
  });
});
