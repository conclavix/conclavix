import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ClaudeCliAdapter } from '../src/runner/adapters/claude-cli.js';
import { RunEventRecorder } from '../src/runner/events.js';
import { REDACTION_FAILED, Redactor } from '../src/runner/redact.js';
import { RunWorker } from '../src/runner/run-worker.js';
import { secretsFromEnv } from '../src/runner/secrets.js';
import { createTestContext, type TestContext } from './helpers.js';
import { createFixture, type Fixture } from './scheduler-helpers.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const GATEWAY_KEY = 'FAKE-gateway-key-for-redaction-0123456789';

describe('run log redaction', () => {
  let ctx: TestContext;
  let fx: Fixture;
  let workspaces: string;

  const eventsOf = (runId: ObjectId) =>
    ctx.database.collections.runEvents.find({ runId }).sort({ seq: 1 }).toArray();

  beforeAll(async () => {
    ctx = await createTestContext();
    fx = await createFixture(ctx);
    workspaces = await mkdtemp(join(tmpdir(), 'cvx-redact-'));
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await rm(workspaces, { recursive: true, force: true });
    await ctx.close();
  });

  it('redacts a known value that straddles the text cap before cutting it', async () => {
    const runId = new ObjectId();
    const recorder = new RunEventRecorder(
      ctx.database.collections,
      runId,
      new Redactor([{ name: 'CVX_SECRET_CEO', value: GATEWAY_KEY }]),
    );
    recorder.record('assistant', `${'x'.repeat(3970)}${GATEWAY_KEY}`);
    await recorder.flush();
    const [event] = await eventsOf(runId);
    expect(event?.text).toContain('[redacted:CVX_SECRET_CEO]');
    expect(event?.text).not.toContain(GATEWAY_KEY.slice(0, 8));
  });

  it('checks only the cut edge when capping an event', async () => {
    const runId = new ObjectId();
    const recorder = new RunEventRecorder(
      ctx.database.collections,
      runId,
      new Redactor([{ name: 'DB_PASSWORD', value: 'postgres1' }]),
    );
    const text = `ostgres1${'x'.repeat(3984)}postgres ordinary continuation`;
    recorder.record('assistant', text);
    recorder.record('assistant', 'ostgres1 is a value');
    await recorder.flush();
    const events = await eventsOf(runId);
    expect(events[0]?.text).toBe(`ostgres1${'x'.repeat(3984)}[redacted:DB_PASSWORD]...`);
    expect(events[1]?.text).toBe('ostgres1 is a value');
  });

  it('passes the whole event document through the redactor before insert', async () => {
    const runId = new ObjectId();
    const redactor = new Redactor();
    const deep = vi.spyOn(redactor, 'deep');
    const recorder = new RunEventRecorder(ctx.database.collections, runId, redactor);
    const pat = ['ghp', '_', 'FAKEfakeFAKEfake0123456789'].join('');
    recorder.record('stderr', `read ${pat}`);
    await recorder.flush();
    expect(deep).toHaveBeenCalledWith(expect.objectContaining({ runId, text: `read ${pat}` }));
    const [event] = await eventsOf(runId);
    expect(event?.text).toBe('read [redacted:github-token]');
  });

  it('redacts structured event data, also a value cut by its field cap', async () => {
    const runId = new ObjectId();
    const recorder = new RunEventRecorder(
      ctx.database.collections,
      runId,
      new Redactor([{ name: 'CVX_SECRET_CEO', value: GATEWAY_KEY }]),
    );
    const input = JSON.stringify({ command: `curl -H "x-key: ${GATEWAY_KEY}"` }, null, 2);
    const cut = `${'y'.repeat(20)}${GATEWAY_KEY.slice(0, 12)}\n[truncated 99 chars]`;
    recorder.record('tool_use', 'Bash', {
      kind: 'tool_use',
      name: 'Bash',
      toolUseId: 'toolu_1',
      input,
    });
    recorder.record('assistant', 'see below', { kind: 'text', markdown: cut });
    await recorder.flush();
    const events = await eventsOf(runId);
    expect(JSON.stringify(events)).not.toContain(GATEWAY_KEY.slice(0, 12));
    expect(events[0]?.data).toMatchObject({ kind: 'tool_use', name: 'Bash' });
    expect(JSON.stringify(events[0]?.data)).toContain('[redacted:CVX_SECRET_CEO]');
    expect(JSON.stringify(events[1]?.data)).toContain('[redacted:CVX_SECRET_CEO]');
  });

  it('stores a placeholder and logs no content when redaction fails', async () => {
    const runId = new ObjectId();
    const broken = new Redactor();
    vi.spyOn(broken, 'deep').mockImplementation(() => {
      throw new Error(`boom ${GATEWAY_KEY}`);
    });
    const recorder = new RunEventRecorder(ctx.database.collections, runId, broken);
    recorder.record('stderr', `leak ${GATEWAY_KEY}`);
    await recorder.flush();
    const events = await eventsOf(runId);
    expect(events.map((event) => event.text)).toEqual([REDACTION_FAILED]);
    expect(JSON.stringify(events)).not.toContain(GATEWAY_KEY);
  });

  it('keeps an agent secret, the run token and pattern secrets out of an end-to-end run', async () => {
    const mcpUrl = `${await ctx.app.listen({ host: '127.0.0.1', port: 0 })}/mcp`;
    const worker = new RunWorker(ctx.database, fx.scheduler, {
      workspacesRoot: workspaces,
      mcpUrl,
      timeoutMs: 10_000,
      knownSecrets: [{ name: 'CVX_SECRET_CEO', value: GATEWAY_KEY }],
      adapters: {
        claude_cli: new ClaudeCliAdapter({
          bin: FAKE,
          extraEnv: { FAKE_CLAUDE_MODE: 'leak' },
          secrets: secretsFromEnv({ CVX_SECRET_CEO: GATEWAY_KEY }),
        }),
      },
    });
    const agent = await fx.agent({ adapter: { type: 'claude_cli', gatewayKeySecret: 'CEO' } });
    const issue = await fx.issue({ title: 'leak check', assigneeAgentId: agent.id });
    await fx.scheduler.processPendingWakes();
    const run = await ctx.database.collections.runs.findOne({ issueId: new ObjectId(issue.id) });
    if (!run) throw new Error('expected a run');

    await worker.process(run._id);

    const events = await eventsOf(run._id);
    const stored = JSON.stringify(events);
    expect(await ctx.database.collections.runs.findOne({ _id: run._id })).toMatchObject({
      status: 'succeeded',
    });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['tool_use', 'assistant', 'stderr', 'result']),
    );
    expect(stored).not.toContain(GATEWAY_KEY);
    expect(stored).not.toContain('cvx_run_');
    expect(stored).not.toContain('FAKEfakeFAKEfake');
    expect(stored).toContain('GATEWAY=[redacted:CVX_SECRET_CEO]');
    expect(stored).toContain('RUN=[redacted:RUN_TOKEN]');
    expect(stored).toContain('[redacted:github-token]');
  });

  it('scrubs credential formats from the stored run error', async () => {
    const agent = await fx.agent();
    const issue = await fx.issue({ title: 'error check', assigneeAgentId: agent.id });
    await fx.scheduler.processPendingWakes();
    const run = await ctx.database.collections.runs.findOne({ issueId: new ObjectId(issue.id) });
    if (!run) throw new Error('expected a run');
    await fx.scheduler.startRun(run._id, 60_000);
    const finished = await fx.scheduler.finishRun(run._id, {
      status: 'failed',
      costUsd: 0,
      error: 'connect failed for mongodb://cvx:FAKEpass0123@db/x',
    });
    expect(finished.error).toBe('connect failed for mongodb://cvx:[redacted:password]@db/x');
  });
});
