import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';
import { createFixture, type Fixture } from './scheduler-helpers.js';

describe('scheduler', () => {
  let ctx: TestContext;
  let fx: Fixture;

  const issueDoc = (id: string) =>
    ctx.database.collections.issues.findOne({ _id: new ObjectId(id) });
  const lastWake = (issueId: string) =>
    ctx.database.collections.wakes
      .find({ issueId: new ObjectId(issueId) })
      .sort({ _id: -1 })
      .next();

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

  it('turns an assignment into exactly one run and checks the issue out', async () => {
    const agent = await fx.agent();
    const issue = await fx.issue({ title: 'work', assigneeAgentId: agent.id });
    await ctx.request({
      method: 'POST',
      url: `/api/issues/${issue.key}/comments`,
      payload: { body: 'go' },
    });
    expect(await fx.pendingWakes()).toBe(1);

    expect(await fx.scheduler.processPendingWakes()).toEqual({ run: 1, skip: 0, defer: 0 });
    expect(fx.dispatcher.runs).toHaveLength(1);
    const run = fx.dispatcher.runs[0];
    expect(run).toMatchObject({ status: 'queued', reason: 'assigned' });
    expect((await issueDoc(issue.id))?.checkoutRunId?.equals(run?._id)).toBe(true);
  });

  it('defers wakes while the issue is checked out and runs them after the run finishes', async () => {
    const agent = await fx.agent();
    const issue = await fx.issue({ title: 'busy', assigneeAgentId: agent.id });
    await fx.scheduler.processPendingWakes();
    await ctx.request({
      method: 'POST',
      url: `/api/issues/${issue.key}/comments`,
      payload: { body: 'more' },
    });

    expect(await fx.scheduler.processPendingWakes()).toEqual({ run: 0, skip: 0, defer: 1 });
    const first = fx.dispatcher.runs[0];
    if (!first) throw new Error('expected a run');
    await fx.scheduler.finishRun(first._id, { status: 'succeeded', costUsd: 0.1 });
    expect((await issueDoc(issue.id))?.checkoutRunId).toBeNull();

    expect(await fx.scheduler.processPendingWakes()).toEqual({ run: 1, skip: 0, defer: 0 });
    expect(fx.dispatcher.runs[1]?.reason).toBe('comment');
  });

  it('skips wakes for paused agents, blocked issues and reassigned issues, with the reason', async () => {
    const paused = await fx.agent();
    const pausedIssue = await fx.issue({ title: 'p', assigneeAgentId: paused.id });
    await ctx.request({
      method: 'PATCH',
      url: `/api/agents/${paused.id}`,
      payload: { status: 'paused' },
    });

    const worker = await fx.agent();
    const blocker = await fx.issue({ title: 'blocker' });
    const blocked = await fx.issue({
      title: 'b',
      assigneeAgentId: worker.id,
      blockedBy: [blocker.id],
    });

    const other = await fx.agent();
    const moved = await fx.issue({ title: 'm', assigneeAgentId: worker.id });
    await fx.patch(moved.key, { assigneeAgentId: other.id });

    await fx.scheduler.processPendingWakes();
    expect((await lastWake(pausedIssue.id))?.skipReason).toBe('agent_paused');
    expect((await lastWake(blocked.id))?.skipReason).toBe('blocked');
    const movedWakes = await ctx.database.collections.wakes
      .find({ issueId: new ObjectId(moved.id) })
      .toArray();
    expect(movedWakes.map((wake) => wake.skipReason ?? 'run').sort()).toEqual([
      'not_assigned',
      'run',
    ]);
  });

  it('does not wake for backlog issues', async () => {
    const agent = await fx.agent();
    await fx.issue({ title: 'later', status: 'backlog', assigneeAgentId: agent.id });
    expect(await fx.pendingWakes()).toBe(0);
  });

  it('wakes the assignee when the last blocker closes', async () => {
    const agent = await fx.agent();
    const a = await fx.issue({ title: 'a' });
    const b = await fx.issue({ title: 'b' });
    const waiting = await fx.issue({
      title: 'w',
      assigneeAgentId: agent.id,
      blockedBy: [a.id, b.id],
    });
    await fx.scheduler.processPendingWakes();

    await fx.patch(a.key, { status: 'done' });
    expect(await fx.pendingWakes()).toBe(0);
    await fx.patch(b.key, { status: 'done' });
    expect((await lastWake(waiting.id))?.reason).toBe('unblocked');
  });

  const comment = (key: string) =>
    ctx.request({ method: 'POST', url: `/api/issues/${key}/comments`, payload: { body: 'ping' } });

  const finishLast = async (now: Date, costUsd = 0.1) => {
    const run = fx.dispatcher.runs.at(-1);
    if (!run) throw new Error('expected a run');
    await fx.scheduler.finishRun(run._id, { status: 'succeeded', costUsd }, now);
  };

  const at = (base: Date, minutes: number) => new Date(base.getTime() + minutes * 60_000);

  it('defers a wake over the hourly run limit and runs it once the window frees', async () => {
    const agent = await fx.agent({
      limits: { maxRunsPerIssuePerHour: 2, maxCostPerRunUsd: 1, maxCostPerDayUsd: 10 },
    });
    const issue = await fx.issue({ title: 'limited', assigneeAgentId: agent.id });
    const t0 = new Date('2030-01-01T10:00:00Z');
    await fx.scheduler.processPendingWakes(t0);
    await finishLast(at(t0, 1));
    await comment(issue.key);
    await fx.scheduler.processPendingWakes(at(t0, 2));
    await finishLast(at(t0, 3));

    await comment(issue.key);
    expect(await fx.scheduler.processPendingWakes(at(t0, 4))).toMatchObject({ run: 0, defer: 1 });
    const deferred = await lastWake(issue.id);
    expect(deferred).toMatchObject({
      processedAt: null,
      skipReason: null,
      deferReason: 'run_rate_limit',
      notBefore: new Date(t0.getTime() + 60 * 60_000 + 1),
    });

    await comment(issue.key);
    await comment(issue.key);
    expect(
      await ctx.database.collections.wakes.countDocuments({ issueId: new ObjectId(issue.id) }),
    ).toBe(3);
    expect(await fx.pendingWakes()).toBe(1);
    expect(await fx.scheduler.processPendingWakes(at(t0, 30))).toEqual({
      run: 0,
      skip: 0,
      defer: 0,
    });

    expect(await fx.scheduler.processPendingWakes(at(t0, 61))).toMatchObject({ run: 1 });
    const run = fx.dispatcher.runs.at(-1);
    expect(fx.dispatcher.runs).toHaveLength(3);
    expect(run?.issueId.toHexString()).toBe(issue.id);
    expect((await lastWake(issue.id))?.runId).toEqual(run?._id);
    expect(await fx.pendingWakes()).toBe(0);
  });

  it('re-checks a deferred wake at once when the board wakes the agent manually', async () => {
    const agent = await fx.agent({
      limits: { maxRunsPerIssuePerHour: 1, maxCostPerRunUsd: 1, maxCostPerDayUsd: 10 },
    });
    const issue = await fx.issue({ title: 'raised', assigneeAgentId: agent.id });
    const t0 = new Date('2030-01-02T10:00:00Z');
    await fx.scheduler.processPendingWakes(t0);
    await finishLast(at(t0, 1));
    await comment(issue.key);
    await fx.scheduler.processPendingWakes(at(t0, 2));
    expect((await lastWake(issue.id))?.deferReason).toBe('run_rate_limit');

    await ctx.request({
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      payload: { limits: { maxRunsPerIssuePerHour: 5, maxCostPerRunUsd: 1, maxCostPerDayUsd: 10 } },
    });
    const manual = await ctx.request({
      method: 'POST',
      url: `/api/agents/${agent.id}/wake`,
      payload: { issueId: issue.id },
    });
    expect(manual.json()).toEqual({ queued: false });
    expect(await fx.scheduler.processPendingWakes(at(t0, 3))).toMatchObject({ run: 1 });
    expect(await fx.pendingWakes()).toBe(0);
  });

  it('defers a wake over the daily cost limit until the next UTC day', async () => {
    const agent = await fx.agent({
      limits: { maxRunsPerIssuePerHour: 4, maxCostPerRunUsd: 1, maxCostPerDayUsd: 1 },
    });
    const issue = await fx.issue({ title: 'expensive', assigneeAgentId: agent.id });
    const t0 = new Date('2030-01-03T22:00:00Z');
    await fx.scheduler.processPendingWakes(t0);
    await finishLast(at(t0, 1), 1);
    await comment(issue.key);
    await fx.scheduler.processPendingWakes(at(t0, 2));
    expect(await lastWake(issue.id)).toMatchObject({
      processedAt: null,
      deferReason: 'daily_cost_limit',
      notBefore: new Date('2030-01-04T00:00:00Z'),
    });
    await fx.scheduler.processPendingWakes(at(t0, 119));
    expect(fx.dispatcher.runs).toHaveLength(1);
    await fx.scheduler.processPendingWakes(at(t0, 120));
    expect(fx.dispatcher.runs).toHaveLength(2);
  });

  it('keeps loop detection for deferred wakes: the agent is paused, its wake skipped', async () => {
    const agent = await fx.agent({
      limits: { maxRunsPerIssuePerHour: 1, maxCostPerRunUsd: 1, maxCostPerDayUsd: 10 },
    });
    const issue = await fx.issue({ title: 'stuck', assigneeAgentId: agent.id });
    const t0 = new Date('2030-01-05T08:00:00Z');
    await fx.scheduler.processPendingWakes(t0);
    for (let hour = 0; hour < 2; hour += 1) {
      await finishLast(at(t0, hour * 61 + 1));
      await comment(issue.key);
      await fx.scheduler.processPendingWakes(at(t0, hour * 61 + 2));
      expect((await lastWake(issue.id))?.deferReason).toBe('run_rate_limit');
      await fx.scheduler.processPendingWakes(at(t0, (hour + 1) * 61));
    }
    await finishLast(at(t0, 123));
    expect(fx.dispatcher.runs).toHaveLength(3);
    const paused = await ctx.request({ method: 'GET', url: `/api/agents/${agent.id}` });
    expect(paused.json().status).toBe('paused');
    await comment(issue.key);
    await fx.scheduler.processPendingWakes(at(t0, 300));
    expect(await lastWake(issue.id)).toMatchObject({ skipReason: 'agent_paused' });
    expect(fx.dispatcher.runs).toHaveLength(3);
  });

  it('rejects finishing a run twice', async () => {
    const agent = await fx.agent();
    await fx.issue({ title: 'once', assigneeAgentId: agent.id });
    await fx.scheduler.processPendingWakes();
    const run = fx.dispatcher.runs[0];
    if (!run) throw new Error('expected a run');
    await fx.scheduler.finishRun(run._id, { status: 'failed', costUsd: 0, error: 'boom' });
    await expect(
      fx.scheduler.finishRun(run._id, { status: 'succeeded', costUsd: 0 }),
    ).rejects.toThrow(/already finished/);
  });
});
