import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';
import { createFixture, type Fixture } from './scheduler-helpers.js';

describe('scheduler limits: idle backoff, run cap per issue, daily cost', () => {
  let ctx: TestContext;
  let fx: Fixture;

  const lastWake = (issueId: string) =>
    ctx.database.collections.wakes
      .find({ issueId: new ObjectId(issueId) })
      .sort({ _id: -1 })
      .next();

  const comment = (key: string) =>
    ctx.request({ method: 'POST', url: `/api/issues/${key}/comments`, payload: { body: 'ping' } });

  const finishLast = async (now: Date, costUsd = 0.1) => {
    const run = fx.dispatcher.runs.at(-1);
    if (!run) throw new Error('expected a run');
    await fx.scheduler.finishRun(run._id, { status: 'succeeded', costUsd }, now);
  };

  const at = (base: Date, minutes: number) => new Date(base.getTime() + minutes * 60_000);

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

  const limits = (maxIdleRunsPerIssue: number, maxCostPerDayUsd = 10) => ({
    limits: { maxIdleRunsPerIssue, maxCostPerRunUsd: 1, maxCostPerDayUsd },
  });

  /** What a status change, document revision or sub-issue does to the issue during a run. */
  const progress = (issueId: string) =>
    ctx.database.collections.issues.updateOne(
      { _id: new ObjectId(issueId) },
      { $inc: { progress: 1 } },
    );

  const agentStatus = async (agentId: string) =>
    (await ctx.request({ method: 'GET', url: `/api/agents/${agentId}` })).json().status;

  it('never throttles runs that make progress, however many there are', async () => {
    const agent = await fx.agent(limits(1));
    const issue = await fx.issue({ title: 'productive', assigneeAgentId: agent.id });
    const t0 = new Date('2030-01-01T10:00:00Z');
    await fx.scheduler.processPendingWakes(t0);
    for (let minute = 1; minute <= 8; minute += 1) {
      await progress(issue.id);
      await finishLast(at(t0, minute * 2 - 1));
      await comment(issue.key);
      expect(await fx.scheduler.processPendingWakes(at(t0, minute * 2))).toMatchObject({ run: 1 });
    }
    expect(fx.dispatcher.runs).toHaveLength(9);
    expect(await agentStatus(agent.id)).toBe('active');
  });

  it('backs off after the idle-run limit, then pauses after one more idle run', async () => {
    const agent = await fx.agent(limits(2));
    const issue = await fx.issue({ title: 'idle', assigneeAgentId: agent.id });
    const t0 = new Date('2030-01-02T10:00:00Z');
    await fx.scheduler.processPendingWakes(t0);
    await finishLast(at(t0, 1));
    await comment(issue.key);
    expect(await fx.scheduler.processPendingWakes(at(t0, 2))).toMatchObject({ run: 1 });
    await finishLast(at(t0, 3));

    await comment(issue.key);
    expect(await fx.scheduler.processPendingWakes(at(t0, 4))).toMatchObject({ run: 0, defer: 1 });
    expect(await lastWake(issue.id)).toMatchObject({
      processedAt: null,
      skipReason: null,
      deferReason: 'idle_backoff',
      notBefore: at(t0, 13),
    });
    await comment(issue.key);
    expect(await fx.pendingWakes()).toBe(1);
    expect(await fx.scheduler.processPendingWakes(at(t0, 12))).toEqual({
      run: 0,
      skip: 0,
      defer: 0,
    });
    expect(await fx.scheduler.processPendingWakes(at(t0, 13))).toMatchObject({ run: 1 });
    expect(await agentStatus(agent.id)).toBe('active');

    await finishLast(at(t0, 14));
    expect(await agentStatus(agent.id)).toBe('paused');
    const comments = (
      await ctx.request({ method: 'GET', url: `/api/issues/${issue.key}/comments` })
    ).json();
    expect(comments.items.at(-1).body).toMatch(/^Agent paused: its last 3 runs/);
    await comment(issue.key);
    await fx.scheduler.processPendingWakes(at(t0, 60));
    expect(await lastWake(issue.id)).toMatchObject({ skipReason: 'agent_paused' });
    expect(fx.dispatcher.runs).toHaveLength(3);
  });

  it('resets the idle count when a run makes progress', async () => {
    const agent = await fx.agent(limits(2));
    const issue = await fx.issue({ title: 'reset', assigneeAgentId: agent.id });
    const t0 = new Date('2030-01-03T10:00:00Z');
    await fx.scheduler.processPendingWakes(t0);
    for (const [minute, productive] of [
      [1, false],
      [3, true],
      [5, false],
      [7, true],
      [9, false],
    ] as const) {
      if (productive) await progress(issue.id);
      await finishLast(at(t0, minute));
      await comment(issue.key);
      expect(await fx.scheduler.processPendingWakes(at(t0, minute + 1))).toMatchObject({ run: 1 });
    }
    await finishLast(at(t0, 11));
    await comment(issue.key);
    expect(await fx.scheduler.processPendingWakes(at(t0, 12))).toMatchObject({ defer: 1 });
    expect((await lastWake(issue.id))?.deferReason).toBe('idle_backoff');
    expect(await agentStatus(agent.id)).toBe('active');
  });

  it('lets a manual board wake skip the idle backoff, but not event wakes', async () => {
    const agent = await fx.agent(limits(1));
    const issue = await fx.issue({ title: 'board', assigneeAgentId: agent.id });
    const t0 = new Date('2030-01-04T10:00:00Z');
    await fx.scheduler.processPendingWakes(t0);
    await finishLast(at(t0, 1));
    await comment(issue.key);
    await fx.scheduler.processPendingWakes(at(t0, 2));
    expect((await lastWake(issue.id))?.deferReason).toBe('idle_backoff');

    const manual = await ctx.request({
      method: 'POST',
      url: `/api/agents/${agent.id}/wake`,
      payload: { issueId: issue.id },
    });
    expect(manual.json()).toEqual({ queued: false });
    expect(await lastWake(issue.id)).toMatchObject({ notBefore: null, boardWake: true });
    expect(await fx.scheduler.processPendingWakes(at(t0, 3))).toMatchObject({ run: 1 });
    expect(await fx.pendingWakes()).toBe(0);
  });

  it('counts a coding run whose commit was synced as progress', async () => {
    const agent = await fx.agent(limits(1));
    const issue = await fx.issue({ title: 'code', assigneeAgentId: agent.id });
    const t0 = new Date('2030-01-05T10:00:00Z');
    const code = (head: string | null, synced: boolean) => ({
      branch: 'cvx/X-1',
      base: 'a'.repeat(40),
      head,
      commit: head,
      agentCommits: 0,
      files: 1,
      insertions: 1,
      deletions: 0,
      synced,
      error: null,
    });
    const finishWithCode = async (minute: number, head: string | null, synced: boolean) => {
      const run = fx.dispatcher.runs.at(-1);
      if (!run) throw new Error('expected a run');
      await ctx.database.collections.runs.updateOne(
        { _id: run._id },
        { $set: { code: code(head, synced) } },
      );
      return fx.scheduler.finishRun(run._id, { status: 'succeeded', costUsd: 0.1 }, at(t0, minute));
    };

    await fx.scheduler.processPendingWakes(t0);
    for (let minute = 1; minute <= 7; minute += 2) {
      const finished = await finishWithCode(minute, 'b'.repeat(40), true);
      expect(finished.madeProgress).toBe(true);
      await comment(issue.key);
      expect(await fx.scheduler.processPendingWakes(at(t0, minute + 1))).toMatchObject({ run: 1 });
    }
    expect((await finishWithCode(9, 'b'.repeat(40), false)).madeProgress).toBe(false);
    await comment(issue.key);
    expect(await fx.scheduler.processPendingWakes(at(t0, 10))).toMatchObject({ defer: 1 });
    await fx.scheduler.processPendingWakes(at(t0, 19));
    expect((await finishWithCode(20, 'a'.repeat(40), true)).madeProgress).toBe(false);
    expect(await agentStatus(agent.id)).toBe('paused');
  });

  it('caps runs per issue and day even when every run makes progress', async () => {
    fx = await createFixture(ctx, { maxRunsPerIssuePerDay: 3 });
    const agent = await fx.agent(limits(2));
    const issue = await fx.issue({ title: 'busy loop', assigneeAgentId: agent.id });
    const t0 = new Date('2030-01-06T10:00:00Z');
    await fx.scheduler.processPendingWakes(t0);
    for (const minute of [1, 3]) {
      await progress(issue.id);
      await finishLast(at(t0, minute));
      await comment(issue.key);
      expect(await fx.scheduler.processPendingWakes(at(t0, minute + 1))).toMatchObject({ run: 1 });
    }
    await progress(issue.id);
    await finishLast(at(t0, 5));
    await comment(issue.key);
    expect(await fx.scheduler.processPendingWakes(at(t0, 6))).toMatchObject({ defer: 1 });
    expect(await lastWake(issue.id)).toMatchObject({
      deferReason: 'issue_run_cap',
      notBefore: at(t0, 24 * 60),
    });
    await ctx.request({
      method: 'POST',
      url: `/api/agents/${agent.id}/wake`,
      payload: { issueId: issue.id },
    });
    expect(await fx.scheduler.processPendingWakes(at(t0, 7))).toMatchObject({ run: 0, defer: 1 });
    expect(await fx.scheduler.processPendingWakes(at(t0, 24 * 60))).toMatchObject({ run: 1 });
  });

  it('defers a wake over the daily cost limit until the next UTC day', async () => {
    const agent = await fx.agent(limits(4, 1));
    const issue = await fx.issue({ title: 'expensive', assigneeAgentId: agent.id });
    const t0 = new Date('2030-01-03T22:00:00Z');
    await fx.scheduler.processPendingWakes(t0);
    await progress(issue.id);
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
});
