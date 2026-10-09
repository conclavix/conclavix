import { ObjectId } from 'mongodb';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommentRepository } from '../src/modules/comments/repository.js';
import { pauseOnLoop } from '../src/modules/scheduler/loop-detection.js';
import { createTestContext, type TestContext } from './helpers.js';
import { createFixture, type Fixture, issueRun } from './scheduler-helpers.js';

const logs = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('pino', () => ({ default: () => ({ error: logs.error, info: vi.fn() }) }));

describe('scheduler failure handling', () => {
  let ctx: TestContext;
  let fx: Fixture;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  beforeEach(async () => {
    logs.error.mockClear();
    await ctx.database.collections.wakes.deleteMany({});
    fx = await createFixture(ctx);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => ctx.close());

  it.each([undefined, 0, 7])(
    'preserves progress %s and detects subsequent progress',
    async (progress) => {
      const agent = await fx.agent();
      const issue = await fx.issue({ title: 'legacy', assigneeAgentId: agent.id });
      const filter = { _id: new ObjectId(issue.id) };
      await ctx.database.collections.issues.updateOne(
        filter,
        progress === undefined ? { $unset: { progress: '' } } : { $set: { progress } },
      );
      await fx.scheduler.processPendingWakes();
      const run = fx.dispatcher.runs[0];
      if (!run) throw new Error('expected a run');
      expect(run.progressAtStart).toBe(progress ?? 0);
      await ctx.database.collections.issues.updateOne(filter, { $inc: { progress: 1 } });
      const finished = await fx.scheduler.finishRun(run._id, { status: 'succeeded', costUsd: 0 });
      expect(finished.madeProgress).toBe(true);
    },
  );

  it('rolls back a comment when its wake cannot be persisted', async () => {
    const agent = await fx.agent();
    const issue = await fx.issue({ title: 'atomic comment', assigneeAgentId: agent.id });
    await ctx.database.collections.wakes.deleteMany({});
    vi.spyOn(ctx.database.collections.wakes, 'updateOne').mockRejectedValueOnce(
      new Error('wake unavailable'),
    );
    const response = await ctx.request({
      method: 'POST',
      url: `/api/issues/${issue.key}/comments`,
      payload: { body: 'retry me' },
    });
    expect(response.statusCode).toBe(500);
    expect(
      await ctx.database.collections.comments.countDocuments({ issueId: new ObjectId(issue.id) }),
    ).toBe(0);
    expect(await fx.pendingWakes()).toBe(0);
    const retry = await ctx.request({
      method: 'POST',
      url: `/api/issues/${issue.key}/comments`,
      payload: { body: 'retry me' },
    });
    expect(retry.statusCode).toBe(201);
    expect(await fx.pendingWakes()).toBe(1);
  });

  it('coalesces comment wakes and avoids waking for an assignee comment', async () => {
    const agent = await fx.agent();
    const issue = await fx.issue({ title: 'coalesce', assigneeAgentId: agent.id });
    const comments = new CommentRepository(ctx.database);
    await comments.create(issue.key, { body: 'board' }, { type: 'board' });
    expect(await fx.pendingWakes()).toBe(1);
    await ctx.database.collections.wakes.deleteMany({});
    await comments.create(issue.key, { body: 'agent' }, { type: 'agent', agentId: agent.id });
    expect(await fx.pendingWakes()).toBe(0);
  });

  it('returns a committed issue and logs a deferred assignment wake on failure', async () => {
    const agent = await fx.agent();
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const failure = new Error('wake unavailable');
    vi.spyOn(ctx.database.collections.wakes, 'updateOne').mockRejectedValueOnce(failure);
    const response = await ctx.request({
      method: 'POST',
      url: '/api/issues',
      payload: { projectId: fx.projectId, title: 'committed', assigneeAgentId: agent.id },
    });
    expect(response.statusCode).toBe(201);
    const issueId = response.json().id as string;
    expect(warning).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(`Wake deferred for issue ${issueId}`),
        cause: failure,
      }),
    );
    await fx.scheduler.sweepHeartbeats();
    expect(
      await ctx.database.collections.wakes.findOne({
        issueId: new ObjectId(issueId),
        processedAt: null,
      }),
    ).not.toBeNull();
  });

  it('returns a committed issue closure when unblocking wakes fails', async () => {
    const agent = await fx.agent();
    const blocker = await fx.issue({ title: 'blocker' });
    const waiting = await fx.issue({
      title: 'waiting',
      assigneeAgentId: agent.id,
      blockedBy: [blocker.id],
    });
    await fx.scheduler.processPendingWakes();
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    vi.spyOn(ctx.database.collections.wakes, 'updateOne').mockRejectedValueOnce(
      new Error('wake unavailable'),
    );
    const response = await ctx.request({
      method: 'PATCH',
      url: `/api/issues/${blocker.key}`,
      payload: { status: 'done' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('done');
    expect(warning).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(blocker.id),
      }),
    );
    await fx.scheduler.sweepHeartbeats();
    expect(
      await ctx.database.collections.wakes.findOne({
        issueId: new ObjectId(waiting.id),
        processedAt: null,
      }),
    ).not.toBeNull();
  });

  it('rolls back the loop pause if its system comment fails, and can retry it', async () => {
    fx = await createFixture(ctx, { idleRunsAfterBackoff: 0 });
    const agent = await fx.agent({
      limits: { maxIdleRunsPerIssue: 1, maxCostPerRunUsd: 2, maxCostPerDayUsd: 20 },
    });
    const issue = await fx.issue({ title: 'pause atomically', assigneeAgentId: agent.id });
    await fx.scheduler.processPendingWakes();
    const run = fx.dispatcher.runs[0];
    if (!run) throw new Error('expected a run');
    vi.spyOn(ctx.database.collections.comments, 'insertOne').mockRejectedValueOnce(
      new Error('comment unavailable'),
    );
    await expect(
      fx.scheduler.finishRun(run._id, { status: 'succeeded', costUsd: 0 }),
    ).rejects.toThrow('comment unavailable');
    expect(
      await ctx.database.collections.agents.findOne({ _id: new ObjectId(agent.id) }),
    ).toMatchObject({ status: 'active' });
    expect(
      await ctx.database.collections.comments.countDocuments({ issueId: new ObjectId(issue.id) }),
    ).toBe(0);
    expect(await pauseOnLoop(ctx.database, issueRun(run), 1, new Date())).toBe(true);
    expect(await pauseOnLoop(ctx.database, issueRun(run), 1, new Date())).toBe(false);
    expect(
      await ctx.database.collections.comments.countDocuments({ issueId: new ObjectId(issue.id) }),
    ).toBe(1);
  });

  it('shares rotation across schedulers and wraps past a full batch of deferred wakes', async () => {
    fx = await createFixture(ctx, { batchSize: 2 });
    const agent = await fx.agent();
    const busy = await Promise.all([
      fx.issue({ title: 'busy one', assigneeAgentId: agent.id }),
      fx.issue({ title: 'busy two', assigneeAgentId: agent.id }),
    ]);
    await fx.scheduler.processPendingWakes();
    for (const issue of busy) {
      await ctx.request({
        method: 'POST',
        url: `/api/agents/${agent.id}/wake`,
        payload: { issueId: issue.id },
      });
    }
    const ready = await fx.issue({ title: 'runnable', assigneeAgentId: agent.id });
    expect(await fx.scheduler.processPendingWakes()).toEqual({ run: 0, skip: 0, defer: 2 });
    const other = await createFixture(ctx, { batchSize: 2 });
    expect(await other.scheduler.processPendingWakes()).toEqual({ run: 1, skip: 0, defer: 0 });
    expect(other.dispatcher.runs[0]?.issueId?.toHexString()).toBe(ready.id);
    expect(await fx.pendingWakes()).toBe(2);
    for (const run of fx.dispatcher.runs) {
      await fx.scheduler.finishRun(run._id, { status: 'succeeded', costUsd: 0 });
    }
    expect(await other.scheduler.processPendingWakes()).toEqual({ run: 2, skip: 0, defer: 0 });
    expect(await fx.pendingWakes()).toBe(0);
  });

  it('fails rejected dispatches, releases checkout, and continues the batch', async () => {
    const agent = await fx.agent();
    const issue = await fx.issue({ title: 'dispatch failure', assigneeAgentId: agent.id });
    await fx.issue({ title: 'dispatch success', assigneeAgentId: agent.id });
    vi.spyOn(fx.dispatcher, 'dispatch').mockRejectedValueOnce(new Error('queue unavailable'));
    expect(await fx.scheduler.processPendingWakes()).toEqual({ run: 2, skip: 0, defer: 0 });
    const failed = await ctx.database.collections.runs.findOne({ issueId: new ObjectId(issue.id) });
    expect(failed).toMatchObject({
      status: 'failed',
      error: 'Dispatch failed: queue unavailable',
      costUsd: 0,
    });
    expect(failed?.finishedAt).toBeInstanceOf(Date);
    expect(
      await ctx.database.collections.issues.findOne({ _id: new ObjectId(issue.id) }),
    ).toMatchObject({ checkoutRunId: null });
    expect(fx.dispatcher.runs).toHaveLength(1);
  });

  it.each([new Error('redis://cvx:FAKEpass0123@queue/x'), 'redis://cvx:FAKEpass0123@queue/x'])(
    'redacts credentials in a rejected dispatch: %s',
    async (error) => {
      const agent = await fx.agent();
      const issue = await fx.issue({ title: 'dispatch redaction', assigneeAgentId: agent.id });
      vi.spyOn(fx.dispatcher, 'dispatch').mockRejectedValueOnce(error);
      await fx.scheduler.processPendingWakes();
      const failed = await ctx.database.collections.runs.findOne({
        issueId: new ObjectId(issue.id),
      });
      expect(failed).toMatchObject({
        status: 'failed',
        error: 'Dispatch failed: redis://cvx:[redacted:password]@queue/x',
      });
    },
  );

  it.each([NaN, Infinity, -Infinity, -0.01])(
    'rejects invalid cost %s without finishing or releasing checkout',
    async (costUsd) => {
      const agent = await fx.agent();
      const issue = await fx.issue({ title: 'invalid cost', assigneeAgentId: agent.id });
      await fx.scheduler.processPendingWakes();
      const run = fx.dispatcher.runs[0];
      if (!run) throw new Error('expected a run');
      await expect(
        fx.scheduler.finishRun(run._id, { status: 'succeeded', costUsd }),
      ).rejects.toThrow('costUsd must be finite and non-negative');
      expect(await ctx.database.collections.runs.findOne({ _id: run._id })).toMatchObject({
        status: 'queued',
        costUsd: 0,
      });
      const stored = await ctx.database.collections.issues.findOne({ _id: new ObjectId(issue.id) });
      expect(stored?.checkoutRunId?.equals(run._id)).toBe(true);
    },
  );

  it.each([0, 0.5, 1.25])(
    'carries the budget and accounts for actual cost %s independently of breaches',
    async (costUsd) => {
      const agent = await fx.agent({
        limits: { maxCostPerRunUsd: 0.5, maxCostPerDayUsd: 1, maxIdleRunsPerIssue: 10 },
      });
      await fx.issue({ title: 'budget', assigneeAgentId: agent.id });
      await fx.scheduler.processPendingWakes();
      const run = fx.dispatcher.runs[0];
      if (!run) throw new Error('expected a run');
      expect(run.maxCostPerRunUsd).toBe(0.5);
      await ctx.database.collections.agents.updateOne(
        { _id: new ObjectId(agent.id) },
        { $set: { 'limits.maxCostPerRunUsd': 10 } },
      );
      const finished = await fx.scheduler.finishRun(run._id, { status: 'succeeded', costUsd });
      expect(finished).toMatchObject({ costUsd, overBudget: costUsd > 0.5, maxCostPerRunUsd: 0.5 });
      const response = await ctx.request({
        method: 'GET',
        url: `/api/runs/${run._id.toHexString()}`,
      });
      expect(response.json()).toMatchObject({
        costUsd,
        overBudget: costUsd > 0.5,
        maxCostPerRunUsd: 0.5,
      });
      await fx.issue({ title: 'next budget', assigneeAgentId: agent.id });
      expect(await fx.scheduler.processPendingWakes()).toMatchObject(
        costUsd >= 1 ? { run: 0, defer: 1 } : { run: 1, defer: 0 },
      );
    },
  );
  it('starts with valid token material in a single conditional write', async () => {
    const agent = await fx.agent();
    await fx.issue({ title: 'atomic start', assigneeAgentId: agent.id });
    await fx.scheduler.processPendingWakes();
    const run = fx.dispatcher.runs[0];
    if (!run) throw new Error('expected run');
    const update = vi.spyOn(ctx.database.collections.runs, 'updateOne');
    const now = new Date();
    const { token } = await fx.scheduler.startRun(run._id, 60_000, now);
    expect(update).toHaveBeenCalledTimes(1);
    const { resolveRunToken } = await import('../src/modules/runs/tokens.js');
    expect(await resolveRunToken(ctx.database.collections, token, now)).toMatchObject({
      status: 'running',
      startedAt: now,
      tokenExpiresAt: new Date(now.getTime() + 60_000),
    });
    await expect(fx.scheduler.startRun(run._id, 60_000)).rejects.toThrow('not queued');
    expect(await resolveRunToken(ctx.database.collections, token, now)).not.toBeNull();
  });

  it('continues recovery after individual finish and dispatch failures', async () => {
    // Give this recovery test an isolated set of runs.
    await ctx.database.collections.runs.deleteMany({});
    const agent = await fx.agent();
    for (let i = 0; i < 4; i += 1) {
      await fx.issue({ title: `recovery ${i}`, assigneeAgentId: agent.id });
    }
    await fx.scheduler.processPendingWakes();
    const runs = fx.dispatcher.runs;
    expect(runs).toHaveLength(4);
    const old = new Date(Date.now() - 120_000);
    for (const run of runs.slice(0, 2)) await fx.scheduler.startRun(run._id, 1, old);
    await ctx.database.collections.runs.updateMany(
      { status: 'queued' },
      { $set: { createdAt: old } },
    );
    vi.spyOn(fx.scheduler, 'finishRun').mockRejectedValueOnce(new Error('finish failed'));
    const dispatch = vi
      .spyOn(fx.dispatcher, 'dispatch')
      .mockRejectedValueOnce(new Error('dispatch failed'));
    expect(await fx.scheduler.recoverRuns(60_000)).toEqual({ failed: 1, redispatched: 1 });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(logs.error).toHaveBeenCalledTimes(2);
    expect(logs.error).toHaveBeenCalledWith(
      {
        err: expect.objectContaining({ message: 'finish failed' }),
        runId: runs[0]?._id.toHexString(),
      },
      'failed to recover running run',
    );
    expect(logs.error).toHaveBeenCalledWith(
      {
        err: expect.objectContaining({ message: 'dispatch failed' }),
        runId: runs[2]?._id.toHexString(),
      },
      'failed to redispatch queued run',
    );
    expect(await ctx.database.collections.runs.countDocuments({ status: 'timed_out' })).toBe(1);
  });
});
