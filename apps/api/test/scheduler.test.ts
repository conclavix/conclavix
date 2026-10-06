import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommentRepository } from '../src/modules/comments/repository.js';
import { IssueRepository } from '../src/modules/issues/repository.js';
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

  describe('comments on in_review issues', () => {
    const inReview = async () => {
      const agent = await fx.agent();
      const issue = await fx.issue({ title: 'needs a decision', assigneeAgentId: agent.id });
      await fx.scheduler.processPendingWakes();
      await finishLast(new Date());
      await fx.patch(issue.key, { status: 'in_review' });
      expect(await fx.pendingWakes()).toBe(0);
      return { agent, issue };
    };

    it('moves the issue back to in_progress and wakes the assignee on a board comment', async () => {
      const { agent, issue } = await inReview();
      const response = await ctx.request({
        method: 'POST',
        url: `/api/issues/${issue.key}/comments`,
        payload: { body: 'go with option B' },
      });
      expect(response.statusCode).toBe(201);
      expect(await issueDoc(issue.id)).toMatchObject({ status: 'in_progress' });
      expect(await fx.pendingWakes()).toBe(1);
      expect(await lastWake(issue.id)).toMatchObject({ reason: 'comment', processedAt: null });

      expect(await fx.scheduler.processPendingWakes()).toEqual({ run: 1, skip: 0, defer: 0 });
      expect(fx.dispatcher.runs.at(-1)).toMatchObject({ reason: 'comment' });
      expect(fx.dispatcher.runs.at(-1)?.agentId.toHexString()).toBe(agent.id);
    });

    it('keeps every answer when two board comments race on the same review', async () => {
      const { issue } = await inReview();
      const responses = await Promise.all([comment(issue.key), comment(issue.key)]);
      expect(responses.map((r) => r.statusCode)).toEqual([201, 201]);
      expect(
        await ctx.database.collections.comments.countDocuments({ issueId: new ObjectId(issue.id) }),
      ).toBe(2);
      expect(await issueDoc(issue.id)).toMatchObject({ status: 'in_progress' });
      expect(await fx.pendingWakes()).toBe(1);
      expect(await lastWake(issue.id)).toMatchObject({ reason: 'comment' });
    });

    it('posts the comment the ordinary way when the review was answered meanwhile', async () => {
      const { issue } = await inReview();
      const update = IssueRepository.prototype.update;
      const spy = vi
        .spyOn(IssueRepository.prototype, 'update')
        .mockImplementationOnce(async function (this: IssueRepository, ...args) {
          // Another answer lands between create()'s read and its transaction.
          await ctx.database.collections.issues.updateOne(
            { _id: new ObjectId(issue.id) },
            { $set: { status: 'in_progress' } },
          );
          return update.apply(this, args);
        });
      try {
        expect((await comment(issue.key)).statusCode).toBe(201);
      } finally {
        spy.mockRestore();
      }
      expect(
        await ctx.database.collections.comments.countDocuments({ issueId: new ObjectId(issue.id) }),
      ).toBe(1);
      expect(await issueDoc(issue.id)).toMatchObject({ status: 'in_progress' });
      expect(await fx.pendingWakes()).toBe(1);
      expect(await lastWake(issue.id)).toMatchObject({ reason: 'comment' });
    });

    it('posts the comment the ordinary way when the review was closed under a closed parent meanwhile', async () => {
      const agent = await fx.agent();
      const parent = await fx.issue({ title: 'parent' });
      const issue = await fx.issue({
        title: 'child in review',
        assigneeAgentId: agent.id,
        parentId: parent.id,
      });
      await fx.scheduler.processPendingWakes();
      await finishLast(new Date());
      await fx.patch(issue.key, { status: 'in_review' });
      expect(await fx.pendingWakes()).toBe(0);
      const update = IssueRepository.prototype.update;
      const spy = vi
        .spyOn(IssueRepository.prototype, 'update')
        .mockImplementationOnce(async function (this: IssueRepository, ...args) {
          // The agent finishes the child and the parent closes before the answer's transaction,
          // so moving the child back to in_progress is no longer allowed.
          await ctx.database.collections.issues.updateMany(
            { _id: { $in: [new ObjectId(issue.id), new ObjectId(parent.id)] } },
            { $set: { status: 'done', closedAt: new Date() } },
          );
          return update.apply(this, args);
        });
      try {
        expect((await comment(issue.key)).statusCode).toBe(201);
      } finally {
        spy.mockRestore();
      }
      expect(
        await ctx.database.collections.comments.countDocuments({ issueId: new ObjectId(issue.id) }),
      ).toBe(1);
      expect(await issueDoc(issue.id)).toMatchObject({ status: 'done' });
      expect(await fx.pendingWakes()).toBe(0);
    });

    it('leaves the issue in review and wakes nobody on an agent comment', async () => {
      const { issue } = await inReview();
      const other = await fx.agent();
      await new CommentRepository(ctx.database).create(
        issue.key,
        { body: 'I agree with option B' },
        { type: 'agent', agentId: other.id },
      );
      expect(await issueDoc(issue.id)).toMatchObject({ status: 'in_review' });
      expect(await fx.pendingWakes()).toBe(0);
    });

    it('keeps an unassigned in_review issue in review on a board comment', async () => {
      const issue = await fx.issue({ title: 'unassigned' });
      await fx.patch(issue.key, { status: 'in_review' });
      await comment(issue.key);
      expect(await issueDoc(issue.id)).toMatchObject({ status: 'in_review' });
      expect(await fx.pendingWakes()).toBe(0);
    });
  });
});
