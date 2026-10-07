import { ObjectId } from 'mongodb';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseStreamLine, type StreamSummary } from '../src/runner/adapters/claude-stream.js';
import { RunEventRecorder } from '../src/runner/events.js';
import { RunWorker } from '../src/runner/run-worker.js';
import { createTestContext, type TestContext } from './helpers.js';
import { createFixture, issueRun } from './scheduler-helpers.js';

const logs = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('pino', () => ({ default: () => ({ error: logs.error }) }));

describe('stream cost validation', () => {
  it.each(['-1', '1e999', '"0.3"', 'null', '{}', 'true'])(
    'preserves the last valid cost for %s',
    (cost) => {
      const summary: StreamSummary = {
        costUsd: 0.12,
        resultSeen: false,
        isError: false,
        errorReason: null,
      };
      parseStreamLine(
        `{"type":"result","subtype":"success","total_cost_usd":${cost}}`,
        summary,
        () => {},
      );
      expect(summary.costUsd).toBe(0.12);
      parseStreamLine(
        '{"type":"result","subtype":"success","total_cost_usd":0}',
        summary,
        () => {},
      );
      expect(summary.costUsd).toBe(0);
      parseStreamLine(
        '{"type":"result","subtype":"success","total_cost_usd":0.5}',
        summary,
        () => {},
      );
      expect(summary.costUsd).toBe(0.5);
    },
  );
});

describe('event persistence failures', () => {
  let ctx: TestContext;
  let workspace: string;
  beforeAll(async () => {
    ctx = await createTestContext();
    workspace = await mkdtemp(join(tmpdir(), 'cvx-failures-'));
  });
  beforeEach(() => logs.error.mockClear());
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await ctx.close();
    await rm(workspace, { recursive: true, force: true });
  });

  it('handles an automatic batch failure and persists subsequent batches', async () => {
    const runId = new ObjectId();
    const events = new RunEventRecorder(ctx.database.collections, runId);
    const failure = new Error('insert failed');
    vi.spyOn(ctx.database.collections.runEvents, 'insertMany').mockRejectedValueOnce(failure);
    for (let i = 0; i < 50; i += 1) events.record('runner', 'first batch');
    events.record('runner', 'later batch');
    await expect(events.flush()).resolves.toBeUndefined();
    expect(logs.error).toHaveBeenCalledExactlyOnceWith(
      { err: failure, runId: runId.toHexString(), batchSize: 50 },
      'failed to persist run events',
    );
    expect(await ctx.database.collections.runEvents.findOne({ runId })).toMatchObject({
      seq: 51,
      text: 'later batch',
    });
  });

  it.each(['insert', 'flush'])('finishes with actual outcome when %s fails', async (failure) => {
    const fx = await createFixture(ctx);
    const agent = await fx.agent();
    const issue = await fx.issue({ title: 'preserve cost', assigneeAgentId: agent.id });
    await fx.scheduler.processPendingWakes();
    const run = fx.dispatcher.runs.find((run) => run.issueId?.toHexString() === issue.id);
    if (!run) throw new Error('expected run');
    if (failure === 'insert') {
      vi.spyOn(ctx.database.collections.runEvents, 'insertMany').mockRejectedValueOnce(
        new Error('offline'),
      );
    } else {
      vi.spyOn(RunEventRecorder.prototype, 'flush').mockRejectedValueOnce(
        new Error('flush failed'),
      );
    }
    const outcome = { status: 'failed' as const, costUsd: 2.5, error: 'budget exceeded' };
    const worker = new RunWorker(ctx.database, fx.scheduler, {
      workspacesRoot: workspace,
      mcpUrl: 'http://unused/mcp',
      timeoutMs: 1000,
      adapters: { claude_cli: { run: async () => outcome } },
    });
    expect(await worker.process(run._id)).toEqual(outcome);
    expect(await ctx.database.collections.runs.findOne({ _id: run._id })).toMatchObject({
      ...outcome,
      tokenHash: null,
      overBudget: true,
    });
    expect(
      await ctx.database.collections.issues.findOne({ _id: issueRun(run).issueId }),
    ).toMatchObject({
      checkoutRunId: null,
    });
  });
});
