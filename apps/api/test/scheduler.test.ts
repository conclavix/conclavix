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

  describe('in_review issues waiting on other issues', () => {
    const waitingParent = async () => {
      const agent = await fx.agent();
      const parent = await fx.issue({ title: 'delegator', assigneeAgentId: agent.id });
      const first = await fx.issue({ title: 'first', parentId: parent.id });
      const second = await fx.issue({ title: 'second', parentId: parent.id });
      await fx.scheduler.processPendingWakes();
      await finishLast(new Date());
      await fx.patch(parent.key, { status: 'in_review' });
      expect(await fx.pendingWakes()).toBe(0);
      return { agent, parent, first, second };
    };

    it('moves the parent back to in_progress and wakes its assignee when a sub-issue closes', async () => {
      const { agent, parent, first } = await waitingParent();
      await fx.patch(first.key, { status: 'done' });
      expect(await issueDoc(parent.id)).toMatchObject({
        status: 'in_progress',
        columnId: 'in_progress',
      });
      expect(await fx.pendingWakes()).toBe(1);
      expect(await lastWake(parent.id)).toMatchObject({
        agentId: new ObjectId(agent.id),
        reason: 'subissue_closed',
        processedAt: null,
      });
      expect(await fx.scheduler.processPendingWakes()).toEqual({ run: 1, skip: 0, defer: 0 });
      expect(fx.dispatcher.runs.at(-1)).toMatchObject({ reason: 'subissue_closed' });
    });

    it('queues one wake when several sub-issues close at once, also on cancel', async () => {
      const { parent, first, second } = await waitingParent();
      await Promise.all([
        fx.patch(first.key, { status: 'done' }),
        fx.patch(second.key, { status: 'cancelled' }),
      ]);
      expect(await issueDoc(first.id)).toMatchObject({ status: 'done' });
      expect(await issueDoc(second.id)).toMatchObject({ status: 'cancelled' });
      expect(await issueDoc(parent.id)).toMatchObject({ status: 'in_progress' });
      expect(await fx.pendingWakes()).toBe(1);
      expect(await lastWake(parent.id)).toMatchObject({ reason: 'subissue_closed' });
    });

    it('wakes the parent again for the next closure after it went back to in_review', async () => {
      const { parent, first, second } = await waitingParent();
      await fx.patch(first.key, { status: 'done' });
      await fx.scheduler.processPendingWakes();
      await finishLast(new Date());
      await fx.patch(parent.key, { status: 'in_review' });
      expect(await fx.pendingWakes()).toBe(0);

      await fx.patch(second.key, { status: 'done' });
      expect(await issueDoc(parent.id)).toMatchObject({ status: 'in_progress' });
      expect(await lastWake(parent.id)).toMatchObject({
        reason: 'subissue_closed',
        processedAt: null,
      });
    });

    it('leaves an unassigned parent in review and ignores sub-issues that do not close', async () => {
      const parent = await fx.issue({ title: 'unassigned' });
      const child = await fx.issue({ title: 'child', parentId: parent.id });
      await fx.patch(parent.key, { status: 'in_review' });
      await fx.patch(child.key, { status: 'done' });
      expect(await issueDoc(parent.id)).toMatchObject({ status: 'in_review' });

      const waiting = await waitingParent();
      await fx.patch(waiting.first.key, { status: 'in_review' });
      expect(await issueDoc(waiting.parent.id)).toMatchObject({ status: 'in_review' });
      expect(await fx.pendingWakes()).toBe(0);
    });

    it('resumes an in_review issue when its last blocker closes', async () => {
      const agent = await fx.agent();
      const a = await fx.issue({ title: 'a' });
      const b = await fx.issue({ title: 'b' });
      const waiting = await fx.issue({
        title: 'w',
        assigneeAgentId: agent.id,
        blockedBy: [a.id, b.id],
      });
      await fx.scheduler.processPendingWakes();
      await fx.patch(waiting.key, { status: 'in_review' });

      await fx.patch(a.key, { status: 'done' });
      expect(await issueDoc(waiting.id)).toMatchObject({ status: 'in_review' });
      expect(await fx.pendingWakes()).toBe(0);
      await fx.patch(b.key, { status: 'cancelled' });
      expect(await issueDoc(waiting.id)).toMatchObject({ status: 'in_progress' });
      expect(await fx.pendingWakes()).toBe(1);
      expect(await lastWake(waiting.id)).toMatchObject({ reason: 'unblocked', processedAt: null });
    });

    it('does not wake a resumed issue again after commit once its wake was picked up', async () => {
      const agent = await fx.agent();
      const blocker = await fx.issue({ title: 'blocker' });
      const waiting = await fx.issue({
        title: 'w',
        assigneeAgentId: agent.id,
        blockedBy: [blocker.id],
      });
      const parent = await fx.issue({ title: 'parent', assigneeAgentId: agent.id });
      const child = await fx.issue({ title: 'child', parentId: parent.id });
      await fx.patch(parent.key, { blockedBy: [child.id] });
      await fx.scheduler.processPendingWakes();
      await fx.patch(waiting.key, { status: 'in_review' });
      await fx.patch(parent.key, { status: 'in_review' });
      for (const run of fx.dispatcher.runs) {
        await fx.scheduler.finishRun(run._id, { status: 'succeeded', costUsd: 0.1 });
      }
      const before = fx.dispatcher.runs.length;

      // Another worker picks up the in-transaction wake before the post-commit wakes run.
      const issues = ctx.database.collections.issues;
      const count = issues.countDocuments.bind(issues);
      let pickedUp = false;
      const spy = vi.spyOn(issues, 'countDocuments').mockImplementation(async (filter, options) => {
        if (!options && !pickedUp) {
          pickedUp = true;
          await fx.scheduler.processPendingWakes();
        }
        return count(filter, options);
      });
      try {
        await fx.patch(blocker.key, { status: 'done' });
        pickedUp = false;
        await fx.patch(child.key, { status: 'done' });
      } finally {
        spy.mockRestore();
      }
      await fx.scheduler.processPendingWakes();
      expect(fx.dispatcher.runs).toHaveLength(before + 2);
      expect(await fx.pendingWakes()).toBe(0);
    });

    it('resumes the parent when a board edit closes its sub-issue', async () => {
      const { parent, first } = await waitingParent();
      const url = `/api/projects/${fx.projectId}/board`;
      const { revision, columns } = (await ctx.request({ method: 'GET', url })).json() as {
        revision: number;
        columns: { id: string; title: string; status: string }[];
      };
      const ship = { id: 'ship', title: 'Ship', status: 'in_review' };
      const put = (rev: number, status: string) =>
        ctx.request({
          method: 'PUT',
          url,
          payload: { revision: rev, columns: [...columns, { ...ship, status }] },
        });
      expect((await put(revision, 'in_review')).statusCode).toBe(200);
      await fx.patch(first.key, { columnId: 'ship' });
      const response = await put(revision + 1, 'done');
      expect(response.statusCode).toBe(200);
      expect(await issueDoc(first.id)).toMatchObject({ status: 'done' });
      expect(await issueDoc(parent.id)).toMatchObject({
        status: 'in_progress',
        columnId: 'in_progress',
      });
      expect(await fx.pendingWakes()).toBe(1);
      expect(await lastWake(parent.id)).toMatchObject({ reason: 'subissue_closed' });
    });
  });
});
