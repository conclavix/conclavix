import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { ClaudeCliAdapter } from '../src/runner/adapters/claude-cli.js';
import type { AdapterRunInput } from '../src/runner/adapters/types.js';

afterEach(() => vi.unstubAllEnvs());

it('passes only PATH/HOME, the run token and explicit overrides to the child, with tool search disabled', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'cvx-env-'));
  const bin = join(workspace, 'claude');
  vi.stubEnv('BOARD_API_TOKEN', 'synthetic-board-secret');
  vi.stubEnv('MONGO_URI', 'synthetic-database-secret');
  vi.stubEnv('REDIS_URL', 'synthetic-redis-secret');
  vi.stubEnv('NODE_OPTIONS', '--no-warnings');
  try {
    await writeFile(
      bin,
      `#!/usr/bin/env node
const allowed = ['PATH', 'HOME', 'EXPLICIT', 'ENABLE_TOOL_SEARCH', 'CONCLAVIX_RUN_TOKEN'];
const valid = Object.keys(process.env).every(key => allowed.includes(key)) &&
  process.env.PATH && process.env.HOME === '/synthetic-home' &&
  process.env.EXPLICIT === 'allowed' && process.env.ENABLE_TOOL_SEARCH === 'false' &&
  process.env.CONCLAVIX_RUN_TOKEN === 'synthetic';
process.stdout.write(JSON.stringify({type: 'result', subtype: valid ? 'success' : 'invalid_env', total_cost_usd: 0}) + '\\n');
`,
      { mode: 0o700 },
    );
    const adapter = new ClaudeCliAdapter({
      bin,
      extraEnv: { HOME: '/synthetic-home', EXPLICIT: 'allowed', ENABLE_TOOL_SEARCH: 'true' },
    });
    const input = {
      workspace,
      prompt: 'test',
      token: 'synthetic',
      mcpUrl: 'http://unused/mcp',
      timeoutMs: 5000,
      run: { maxCostPerRunUsd: 1 },
      agent: { adapter: { type: 'claude_cli' } },
      onEvent: () => {},
    } as unknown as AdapterRunInput;
    expect(await adapter.run(input)).toEqual({ status: 'succeeded', costUsd: 0 });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
