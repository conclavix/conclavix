import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';
import { createFixture, type Fixture } from './scheduler-helpers.js';

describe('in_review hand-back when sub-issues and blockers close', () => {
  let ctx: TestContext;
  let fx: Fixture;

  const issueDoc = (id: string) =>
    ctx.database.collections.issues.findOne({ _id: new ObjectId(id) });
  const lastWake = (issueId: string) =>
    ctx.database.collections.wakes
      .find({ issueId: new ObjectId(issueId) })
      .sort({ _id: -1 })
      .next();
  const finishLast = async (now: Date, costUsd = 0.1) => {
    const run = fx.dispatcher.runs.at(-1);
    if (!run) throw new Error('expected a run');
    await fx.scheduler.finishRun(run._id, { status: 'succeeded', costUsd }, now);
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

    it('keeps a parent in review while it still has an open blocker', async () => {
      const { parent, first } = await waitingParent();
      const gate = await fx.issue({ title: 'gate' });
      await fx.patch(parent.key, { blockedBy: [gate.id] });
      await fx.patch(first.key, { status: 'done' });
      expect(await issueDoc(parent.id)).toMatchObject({ status: 'in_review' });
      expect(await fx.pendingWakes()).toBe(0);
      await fx.patch(gate.key, { status: 'done' });
      expect(await issueDoc(parent.id)).toMatchObject({ status: 'in_progress' });
      expect(await lastWake(parent.id)).toMatchObject({ reason: 'unblocked', processedAt: null });
    });

    it('keeps the issue in review when its assignee could not run', async () => {
      const { agent, parent, first } = await waitingParent();
      await ctx.request({
        method: 'PATCH',
        url: `/api/agents/${agent.id}`,
        payload: { status: 'paused' },
      });
      await fx.patch(first.key, { status: 'done' });
      expect(await issueDoc(parent.id)).toMatchObject({ status: 'in_review' });
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
