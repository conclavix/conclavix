import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeCliAdapter } from '../src/runner/adapters/claude-cli.js';
import { RunWorker } from '../src/runner/run-worker.js';
import { secretsFromEnv } from '../src/runner/secrets.js';
import { createTestContext, type TestContext } from './helpers.js';
import { createFixture, type Fixture } from './scheduler-helpers.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

describe('per-agent LLM gateway keys', () => {
  let ctx: TestContext;
  let fx: Fixture;
  let workspaces: string;
  let worker: RunWorker;

  const runFor = async (adapter: Record<string, unknown>) => {
    const agent = await fx.agent({ adapter });
    const issue = await fx.issue({ title: 'key check', assigneeAgentId: agent.id });
    await fx.scheduler.processPendingWakes();
    const run = await ctx.database.collections.runs.findOne({ issueId: new ObjectId(issue.id) });
    if (!run) throw new Error('expected a run');
    await worker.process(run._id);
    const done = await ctx.database.collections.runs.findOne({ _id: run._id });
    const comment = await ctx.database.collections.comments.findOne({ issueId: run.issueId });
    return { run: done, body: comment?.body ?? '' };
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    const mcpUrl = `${await ctx.app.listen({ host: '127.0.0.1', port: 0 })}/mcp`;
    fx = await createFixture(ctx);
    workspaces = await mkdtemp(join(tmpdir(), 'cvx-keys-'));
    worker = new RunWorker(ctx.database, fx.scheduler, {
      workspacesRoot: workspaces,
      mcpUrl,
      timeoutMs: 10_000,
      adapters: {
        claude_cli: new ClaudeCliAdapter({
          bin: FAKE,
          extraEnv: {
            FAKE_CLAUDE_MODE: 'success',
            ANTHROPIC_CUSTOM_HEADERS: 'x-litellm-api-key: Bearer sk-shared',
          },
          secrets: secretsFromEnv({
            CVX_SECRET_CEO: 'sk-ceo',
            CVX_SECRET_LF: 'sk-private\nx-injected: value',
            CVX_SECRET_CR: 'sk-private\rx-injected: value',
            CVX_SECRET_CRLF: 'sk-private\r\nx-injected: value',
            BOARD_TOKEN: 'board-secret',
          }),
        }),
      },
    });
  });

  afterAll(async () => {
    await rm(workspaces, { recursive: true, force: true });
    await ctx.close();
  });

  it("uses the agent's own key instead of the shared one", async () => {
    const { run, body } = await runFor({ type: 'claude_cli', gatewayKeySecret: 'CEO' });
    expect(run?.status).toBe('succeeded');
    expect(body).toContain('gateway=x-litellm-api-key: Bearer sk-ceo');
    expect(body).not.toContain('sk-shared');
  });

  it('falls back to the shared key when the agent names none', async () => {
    const { body } = await runFor({ type: 'claude_cli' });
    expect(body).toContain('gateway=x-litellm-api-key: Bearer sk-shared');
  });

  it('fails the run when the named secret is missing, without revealing any value', async () => {
    const { run, body } = await runFor({ type: 'claude_cli', gatewayKeySecret: 'MISSING' });
    expect(run?.status).toBe('failed');
    expect(run?.error).toContain(
      'secret MISSING is not configured on the runner (set CVX_SECRET_MISSING)',
    );
    expect(run?.error).not.toContain('sk-');
    expect(body).toBe('');
  });

  it('cannot reach variables outside the CVX_SECRET_ prefix', async () => {
    const { run } = await runFor({ type: 'claude_cli', gatewayKeySecret: 'BOARD_TOKEN' });
    expect(run?.status).toBe('failed');
    expect(run?.error).not.toContain('board-secret');
  });

  it.each(['LF', 'CR', 'CRLF'])(
    'fails the run for a key containing %s without exposing it or invoking Claude',
    async (gatewayKeySecret) => {
      const { run, body } = await runFor({ type: 'claude_cli', gatewayKeySecret });
      expect(run?.status).toBe('failed');
      expect(run?.error).toBe(`Error: secret ${gatewayKeySecret} contains a line break`);
      expect(run?.error).not.toContain('sk-private');
      expect(run?.error).not.toContain('x-injected');
      expect(body).toBe('');
    },
  );

  it('rejects a raw key where a secret name belongs', async () => {
    const response = await ctx.request({
      method: 'POST',
      url: '/api/agents',
      payload: {
        name: 'Leaky',
        role: 'x',
        adapter: { type: 'claude_cli', gatewayKeySecret: 'sk-abc123' },
      },
    });
    expect(response.statusCode).toBe(400);
  });
});
