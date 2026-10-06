import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Worker } from 'bullmq';
import { ObjectId } from 'mongodb';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunDoc } from '../src/db.js';
import { Scheduler } from '../src/modules/scheduler/scheduler.js';
import { ClaudeCliAdapter } from '../src/runner/adapters/claude-cli.js';
import { QueueDispatcher, redisConnection, startQueueWorker } from '../src/runner/queue.js';
import { RunEventRecorder } from '../src/runner/events.js';
import { RunWorker } from '../src/runner/run-worker.js';
import { createTestContext, type TestContext } from './helpers.js';
import { createFixture, type Fixture } from './scheduler-helpers.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const REDIS = process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6390';

describe('runner', () => {
  let ctx: TestContext;
  let fx: Fixture;
  let workspaces: string;
  let mcpUrl: string;
  const prefix = `cvx-test-${new ObjectId().toHexString()}`;
  const closers: (() => Promise<void>)[] = [];

  const workerFor = (mode: string, timeoutMs = 10_000) =>
    new RunWorker(ctx.database, fx.scheduler, {
      workspacesRoot: workspaces,
      mcpUrl,
      timeoutMs,
      adapters: {
        claude_cli: new ClaudeCliAdapter({ bin: FAKE, extraEnv: { FAKE_CLAUDE_MODE: mode } }),
      },
    });
  const queuedRun = async (payload: Record<string, unknown> = {}): Promise<RunDoc> => {
    const agent = await fx.agent(payload);
    const issue = await fx.issue({ title: 'run me', assigneeAgentId: agent.id });
    await fx.scheduler.processPendingWakes();
    const run = await ctx.database.collections.runs.findOne({ issueId: new ObjectId(issue.id) });
    if (!run) throw new Error('expected a run');
    return run;
  };
  const runDoc = (id: ObjectId) => ctx.database.collections.runs.findOne({ _id: id });

  beforeAll(async () => {
    ctx = await createTestContext();
    mcpUrl = `${await ctx.app.listen({ host: '127.0.0.1', port: 0 })}/mcp`;
    fx = await createFixture(ctx);
    workspaces = await mkdtemp(join(tmpdir(), 'cvx-ws-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    for (const close of closers) await close();
    await rm(workspaces, { recursive: true, force: true });
    await ctx.close();
  });

  it('runs a queued run end to end through BullMQ, the adapter and the agent API', async () => {
    const connection = redisConnection(REDIS);
    const dispatcher = new QueueDispatcher(connection, prefix);
    const scheduler = new Scheduler(ctx.database, dispatcher);
    const runWorker = new RunWorker(ctx.database, scheduler, {
      workspacesRoot: workspaces,
      mcpUrl,
      timeoutMs: 10_000,
      adapters: {
        claude_cli: new ClaudeCliAdapter({ bin: FAKE, extraEnv: { FAKE_CLAUDE_MODE: 'success' } }),
      },
    });
    const worker: Worker = startQueueWorker(connection, runWorker, 2, prefix);
    closers.push(
      () => worker.close(),
      () => dispatcher.close(),
    );

    const agent = await fx.agent();
    const issue = await fx.issue({ title: 'through the queue', assigneeAgentId: agent.id });
    await scheduler.processPendingWakes();

    let run: RunDoc | null = null;
    for (let i = 0; i < 100 && run?.status !== 'succeeded' && run?.status !== 'failed'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      run = await ctx.database.collections.runs.findOne({ issueId: new ObjectId(issue.id) });
    }
    expect(run).toMatchObject({ status: 'succeeded', costUsd: 0.12, tokenHash: null });

    const comments = (
      await ctx.request({ method: 'GET', url: `/api/issues/${issue.key}/comments` })
    ).json();
    const body: string = comments.items[0].body;
    expect(comments.items[0].author).toEqual({ type: 'agent', agentId: agent.id });
    expect(body).toContain('budget=2;');
    expect(body).toContain('toolsearch=false');
    expect(body).toContain('argvtoken=false;');
    expect(body).toContain('tools=Read,Grep,Glob,Skill;');
    expect(body).toContain('permissions=dontAsk;');
    expect(body).toContain(join(workspaces, agent.id));

    const events = (
      await ctx.request({ method: 'GET', url: `/api/runs/${run?._id.toHexString()}/events` })
    ).json();
    const types = events.items.map((event: { type: string }) => event.type);
    expect(types).toEqual(
      expect.arrayContaining(['runner', 'system', 'tool_use', 'assistant', 'result']),
    );
    expect(
      (await ctx.database.collections.issues.findOne({ _id: new ObjectId(issue.id) }))
        ?.checkoutRunId,
    ).toBeNull();
  });

  it('passes prompt and instructions on stdin, never in the argv sudo would log', async () => {
    const instructions = 'Synthetic agent instructions: always answer in haiku form.';
    const run = await queuedRun({ instructions });
    const record = join(workspaces, `record-${run._id.toHexString()}.json`);
    const worker = new RunWorker(ctx.database, fx.scheduler, {
      workspacesRoot: workspaces,
      mcpUrl,
      timeoutMs: 10_000,
      adapters: {
        claude_cli: new ClaudeCliAdapter({
          bin: FAKE,
          extraEnv: { FAKE_CLAUDE_MODE: 'success', FAKE_CLAUDE_RECORD: record },
        }),
      },
    });
    await worker.process(run._id);
    expect(await runDoc(run._id)).toMatchObject({ status: 'succeeded' });

    const recorded = JSON.parse(await readFile(record, 'utf8')) as {
      args: string[];
      prompt: string;
      instructions: string;
    };
    expect(recorded.instructions).toBe(instructions);
    expect(recorded.prompt).toContain('run me');
    expect(recorded.prompt).toContain('Call get_issue first');
    const argv = recorded.args.join('\n');
    expect(argv).not.toContain(instructions);
    for (const line of recorded.prompt.split('\n').filter((text) => text.trim().length > 8)) {
      expect(argv).not.toContain(line);
    }
    expect(recorded.args).not.toContain('--append-system-prompt');
    expect(recorded.args).toEqual(expect.arrayContaining(['--input-format', 'stream-json']));
  });

  it.each(['insert', 'flush'])('keeps the adapter outcome when event %s fails', async (failure) => {
    const run = await queuedRun();
    if (failure === 'insert') {
      vi.spyOn(ctx.database.collections.runEvents, 'insertMany').mockRejectedValue(
        new Error('write failed'),
      );
    } else {
      vi.spyOn(RunEventRecorder.prototype, 'flush').mockRejectedValue(new Error('flush failed'));
    }
    await workerFor('budget').process(run._id);
    expect(await runDoc(run._id)).toMatchObject({
      status: 'failed',
      costUsd: 0.5,
      error: 'error_max_budget_usd',
      tokenHash: null,
    });
    expect(
      (await ctx.database.collections.issues.findOne({ _id: run.issueId }))?.checkoutRunId,
    ).toBeNull();
  });

  it('isolates the CLI environment and applies explicit overrides', async () => {
    vi.stubEnv('RUNNER_TEST_SECRET', 'must-not-leak');
    vi.stubEnv('FAKE_CLAUDE_MODE', 'fail');
    const run = await queuedRun();
    await workerFor('success').process(run._id);
    expect(await runDoc(run._id)).toMatchObject({ status: 'succeeded' });
    const comment = await ctx.database.collections.comments.findOne({ issueId: run.issueId });
    expect(comment?.body).toContain('secret=undefined');
    expect(comment?.body).toContain('toolsearch=false');
  });

  it('marks a crashing CLI as failed and keeps its stderr', async () => {
    const run = await queuedRun();
    await workerFor('fail').process(run._id);
    expect(await runDoc(run._id)).toMatchObject({
      status: 'failed',
      error: 'claude exited with code 1',
    });
    const stderr = await ctx.database.collections.runEvents.findOne({
      runId: run._id,
      type: 'stderr',
    });
    expect(stderr?.text).toContain('boom');
  });

  it('stops a hanging CLI at the time limit', async () => {
    const run = await queuedRun();
    await workerFor('hang', 1500).process(run._id);
    expect(await runDoc(run._id)).toMatchObject({ status: 'timed_out' });
  });

  it('records the cost of a run that hit its budget', async () => {
    const run = await queuedRun();
    await workerFor('budget').process(run._id);
    expect(await runDoc(run._id)).toMatchObject({
      status: 'failed',
      error: 'error_max_budget_usd',
      costUsd: 0.5,
    });
  });

  it('fails runs for adapters that are not available', async () => {
    const run = await queuedRun({ adapter: { type: 'codex_cli' } });
    await workerFor('success').process(run._id);
    expect(await runDoc(run._id)).toMatchObject({
      status: 'failed',
      error: 'adapter codex_cli is not available',
    });
  });

  it('executes a run once even when two workers pick it up', async () => {
    const run = await queuedRun();
    const results = await Promise.all([
      workerFor('success').process(run._id),
      workerFor('success').process(run._id),
    ]);
    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(await ctx.database.collections.comments.countDocuments({ issueId: run.issueId })).toBe(
      1,
    );
  });

  it('recovers runs whose runner vanished and re-dispatches stuck queued runs', async () => {
    const lost = await queuedRun();
    await fx.scheduler.startRun(lost._id, 60_000, new Date(Date.now() - 2 * 60 * 60 * 1000));
    const stuck = await queuedRun();
    await ctx.database.collections.runs.updateOne(
      { _id: stuck._id },
      { $set: { createdAt: new Date(Date.now() - 5 * 60_000) } },
    );
    const before = fx.dispatcher.runs.length;

    const recovered = await fx.scheduler.recoverRuns(60 * 60 * 1000);
    expect(recovered.failed).toBeGreaterThanOrEqual(1);
    expect(await runDoc(lost._id)).toMatchObject({
      status: 'timed_out',
      error: 'runner lost the run',
    });
    expect(
      (await ctx.database.collections.issues.findOne({ _id: lost.issueId }))?.checkoutRunId,
    ).toBeNull();
    expect(fx.dispatcher.runs.slice(before).some((run) => run._id.equals(stuck._id))).toBe(true);
  });
});

describe('claude environment', () => {
  it('forwards only claude configuration, never the runner secrets', async () => {
    const { claudeEnvFrom } = await import('../src/runner/adapters/claude-cli.js');
    expect(
      claudeEnvFrom({
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000',
        CLAUDE_CODE_USE_BEDROCK: '0',
        LANG: 'C.UTF-8',
        BOARD_TOKEN: 'secret',
        MONGO_URI: 'mongodb://x',
        REDIS_URL: 'redis://x',
        PATH: '/usr/bin',
      }),
    ).toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000',
      CLAUDE_CODE_USE_BEDROCK: '0',
      LANG: 'C.UTF-8',
    });
  });
});
