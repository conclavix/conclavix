import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectId } from 'mongodb';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/modules/audit/audit.js';
import { vaultBox } from '../src/modules/settings/secret-box.js';
import { ClaudeCliAdapter, projectSecretEnv } from '../src/runner/adapters/claude-cli.js';
import type { Adapter, AdapterRunInput } from '../src/runner/adapters/types.js';
import type { CodeRuns } from '../src/runner/code-run.js';
import { RunWorker } from '../src/runner/run-worker.js';
import { AUTH_SECRET, createTestContext, type TestContext } from './helpers.js';
import { createFixture, type Fixture } from './scheduler-helpers.js';

const VALUE = 'sk_test_runner-secret-0123456789';
const OTHER_VALUE = 'other-project-secret-9876543210';

/** Claude stand-in: reports what it got and repeats the secret in its output. */
function recordingAdapter(seen: AdapterRunInput[]): Adapter {
  return {
    run: async (input) => {
      seen.push(input);
      const leaked = input.secretEnv?.['STRIPE_TEST_KEY'] ?? 'nothing';
      input.onEvent('assistant', `the key is ${leaked}`);
      input.onEvent('stderr', `debug ${leaked}`);
      return {
        status: 'failed',
        costUsd: 0,
        error: `tests failed with ${leaked}`,
        summary: leaked,
      };
    },
  };
}

const fakeCodeRuns = (projectId: string): CodeRuns =>
  ({
    prepare: async (issue: { key: string }) => ({
      projectId,
      issueKey: issue.key,
      skillsDir: null,
      branch: `cvx/${issue.key}`,
      base: null,
    }),
    finish: async () => ({}),
  }) as unknown as CodeRuns;

describe('project secrets in runs', () => {
  let ctx: TestContext;
  let fx: Fixture;
  let workspaces: string;
  let coder: { id: string };
  let otherCoder: { id: string };
  let reader: { id: string };

  const worker = (seen: AdapterRunInput[], withBox = true) =>
    new RunWorker(ctx.database, fx.scheduler, {
      workspacesRoot: workspaces,
      mcpUrl: 'http://127.0.0.1:9/mcp',
      timeoutMs: 10_000,
      codeRuns: fakeCodeRuns(fx.projectId),
      secretBox: withBox ? vaultBox(AUTH_SECRET) : null,
      audit: new AuditLog(ctx.database.collections, pino({ level: 'silent' })),
      adapters: { claude_cli: recordingAdapter(seen) },
    });

  /** Queue a run of `agentId` on a new issue and return its id. */
  async function queueRun(agentId: string): Promise<ObjectId> {
    const issue = await fx.issue({
      title: `work ${new ObjectId().toHexString()}`,
      assigneeAgentId: agentId,
    });
    await fx.scheduler.processPendingWakes();
    const run = await ctx.database.collections.runs.findOne({ issueId: new ObjectId(issue.id) });
    if (!run) throw new Error('expected a run');
    return run._id;
  }

  const stored = async (runId: ObjectId) =>
    JSON.stringify([
      await ctx.database.collections.runEvents.find({ runId }).toArray(),
      await ctx.database.collections.runs.findOne({ _id: runId }),
    ]);

  beforeAll(async () => {
    ctx = await createTestContext();
    fx = await createFixture(ctx);
    workspaces = await mkdtemp(join(tmpdir(), 'cvx-secrets-'));
    coder = await fx.agent({ codeAccess: 'write' });
    otherCoder = await fx.agent({ codeAccess: 'write' });
    reader = await fx.agent();
    const create = (projectId: string, payload: object) =>
      ctx.request({ method: 'POST', url: `/api/projects/${projectId}/secrets`, payload });
    await create(fx.projectId, {
      name: 'Stripe',
      envName: 'STRIPE_TEST_KEY',
      value: VALUE,
      agentIds: [coder.id, reader.id],
    });
    const other = await ctx.request({
      method: 'POST',
      url: '/api/projects',
      payload: { key: 'OTH', name: 'Other', autoPlan: false },
    });
    await create(other.json().id as string, {
      name: 'Other',
      envName: 'OTHER_PROJECT_KEY',
      value: OTHER_VALUE,
      agentIds: [coder.id],
    });
  });

  afterAll(async () => {
    await rm(workspaces, { recursive: true, force: true });
    await ctx.close();
  });

  it('passes a secret to the coding run of a selected agent and redacts it everywhere', async () => {
    const seen: AdapterRunInput[] = [];
    const runId = await queueRun(coder.id);
    await worker(seen).process(runId);

    expect(seen[0]?.secretEnv).toEqual({ STRIPE_TEST_KEY: VALUE });
    const log = await stored(runId);
    expect(log).not.toContain(VALUE);
    expect(log).not.toContain(OTHER_VALUE);
    expect(log).toContain('the key is [redacted:STRIPE_TEST_KEY]');
    expect(log).toContain('tests failed with [redacted:STRIPE_TEST_KEY]');
    expect(log).toContain('project secrets in the environment: STRIPE_TEST_KEY');

    const used = await ctx.database.collections.audit.findOne({
      action: 'secret.used',
      'details.runId': runId.toHexString(),
    });
    expect(used?.details).toMatchObject({ envName: 'STRIPE_TEST_KEY', agentId: coder.id });
    expect(JSON.stringify(used)).not.toContain(VALUE);
    const secret = await ctx.database.collections.secrets.findOne({ envName: 'STRIPE_TEST_KEY' });
    expect(secret?.lastUsedRunId?.toHexString()).toBe(runId.toHexString());
  });

  it('gives nothing to agents that were not selected', async () => {
    const seen: AdapterRunInput[] = [];
    await worker(seen).process(await queueRun(otherCoder.id));
    expect(seen[0]?.code).toBeDefined();
    expect(seen[0]?.secretEnv).toBeUndefined();
  });

  it('gives nothing to read-only agents, even when selected', async () => {
    const seen: AdapterRunInput[] = [];
    const runId = await queueRun(reader.id);
    await worker(seen).process(runId);
    expect(seen[0]?.code).toBeUndefined();
    expect(seen[0]?.secretEnv).toBeUndefined();
    expect(
      await ctx.database.collections.audit.countDocuments({
        action: 'secret.used',
        'details.runId': runId.toHexString(),
      }),
    ).toBe(0);
  });

  it('fails the run clearly when the runner cannot decrypt', async () => {
    const seen: AdapterRunInput[] = [];
    const runId = await queueRun(coder.id);
    const result = await worker(seen, false).process(runId);
    expect(result).toMatchObject({ status: 'failed', error: expect.stringMatching(/AUTH_SECRET/) });
    expect(seen).toHaveLength(0);
  });
});

describe('the sandbox environment block', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cvx-fake-sudo-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const input = (secretEnv?: Record<string, string>) =>
    ({
      run: { _id: new ObjectId(), maxCostPerRunUsd: 1 },
      agent: { instructions: '', adapter: { type: 'claude_cli' } },
      issue: { key: 'VLT-1' },
      prompt: 'do it',
      workspace: dir,
      mcpUrl: 'http://127.0.0.1:9/mcp',
      token: 'run-token-value-123',
      timeoutMs: 20_000,
      code: { projectId: new ObjectId().toHexString(), issueKey: 'VLT-1', skillsDir: null },
      ...(secretEnv ? { secretEnv } : {}),
      onEvent: () => undefined,
    }) as unknown as AdapterRunInput;

  it('carries the secrets on stdin ahead of the run variables, never in argv', async () => {
    // Stands in for sudo: stores its stdin and argv next to the "helper" path it is given.
    const sudo = join(dir, 'sudo');
    await writeFile(sudo, `#!/bin/sh\ncat > "$2.stdin"\nprintf '%s\\n' "$@" > "$2.argv"\n`);
    await chmod(sudo, 0o755);
    const helper = join(dir, 'helper');
    const adapter = new ClaudeCliAdapter({
      bin: '/usr/bin/false',
      sandbox: {
        helper,
        sudo,
        limits: { memoryMax: '1G', cpuQuotaPercent: 100, tasksMax: 64, diskLimitMb: 100 },
        extraDomains: [],
      },
    });
    await adapter.run(input({ STRIPE_TEST_KEY: VALUE }));
    const stdin = await readFile(`${helper}.stdin`, 'utf8');
    const block = stdin.slice(0, stdin.indexOf('\n\n')).split('\n');
    const decoded = Object.fromEntries(
      block.map((line) => [
        line.slice(0, line.indexOf('=')),
        Buffer.from(line.slice(line.indexOf('=') + 1), 'base64').toString('utf8'),
      ]),
    );
    expect(decoded['STRIPE_TEST_KEY']).toBe(VALUE);
    expect(decoded['CONCLAVIX_RUN_BEARER']).toBe('run-token-value-123');
    expect(await readFile(`${helper}.argv`, 'utf8')).not.toContain(VALUE);
  });

  it('refuses a reserved name even if one got past the API', () => {
    expect(() => projectSecretEnv(input({ PATH: '/tmp/evil' }))).toThrow(/reserved/);
    expect(() => projectSecretEnv(input({ CONCLAVIX_RUN_BEARER: 'x' }))).toThrow(/reserved/);
    expect(projectSecretEnv(input({ API_BASE: 'https://x' }))).toEqual({ API_BASE: 'https://x' });
  });
});
