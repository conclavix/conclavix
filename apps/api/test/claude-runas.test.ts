import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentRunAs,
  ClaudeCliAdapter,
  claudeArgs,
  claudeCommand,
  claudeStdin,
  mcpConfig,
  RUN_TOKEN_ENV,
} from '../src/runner/adapters/claude-cli.js';
import type { AdapterRunInput } from '../src/runner/adapters/types.js';

const TOKEN = 'synthetic-run-token-0123456789';

const input = (workspace = '/unused') =>
  ({
    workspace,
    prompt: 'test',
    token: TOKEN,
    mcpUrl: 'http://127.0.0.1:1/mcp',
    timeoutMs: 5000,
    run: { maxCostPerRunUsd: 1 },
    agent: { adapter: { type: 'claude_cli' } },
    onEvent: () => {},
  }) as unknown as AdapterRunInput;

describe('run token', () => {
  it('never appears in the claude arguments', () => {
    const args = claudeArgs(input());
    expect(args.join(' ')).not.toContain(TOKEN);
  });

  it('is referenced by the MCP config through the environment', () => {
    const config = JSON.parse(mcpConfig('http://api/mcp')) as {
      mcpServers: { conclavix: { url: string; headers: Record<string, string> } };
    };
    expect(config.mcpServers.conclavix).toMatchObject({
      url: 'http://api/mcp',
      headers: { Authorization: `Bearer \${${RUN_TOKEN_ENV}}` },
    });
  });
});

describe('prompt and instructions', () => {
  const withText = {
    ...input(),
    prompt: 'synthetic task prompt text',
    agent: { adapter: { type: 'claude_cli' }, instructions: 'synthetic agent instructions' },
  } as unknown as AdapterRunInput;

  it('stay out of the claude arguments', () => {
    const args = claudeArgs(withText).join('\n');
    expect(args).not.toContain('synthetic task prompt text');
    expect(args).not.toContain('synthetic agent instructions');
    expect(args).not.toContain('--append-system-prompt');
  });

  it('reach claude as stream-json input on stdin', () => {
    const lines = claudeStdin(withText)
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toEqual([
      {
        type: 'control_request',
        request_id: 'conclavix-init',
        request: { subtype: 'initialize', appendSystemPrompt: 'synthetic agent instructions' },
      },
      {
        type: 'user',
        session_id: '',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'synthetic task prompt text' },
      },
    ]);
  });

  it('send no appended system prompt when the agent has no instructions', () => {
    const first = JSON.parse(claudeStdin(input()).split('\n')[0] ?? '') as {
      request: Record<string, unknown>;
    };
    expect(first.request).toEqual({ subtype: 'initialize' });
  });
});

describe('agent user', () => {
  it('is optional', () => {
    expect(agentRunAs(undefined, '/usr/bin/sudo', 'cvx-runner')).toBeUndefined();
  });

  it('must differ from the runner user and root', () => {
    expect(() => agentRunAs('cvx-runner', '/usr/bin/sudo', 'cvx-runner')).toThrow(/must differ/);
    expect(() => agentRunAs('root', '/usr/bin/sudo', 'cvx-runner')).toThrow(/must differ/);
    expect(agentRunAs('cvx-agent', '/usr/bin/sudo', 'cvx-runner')).toEqual({
      user: 'cvx-agent',
      sudo: '/usr/bin/sudo',
    });
  });

  it('starts claude through sudo -n with a hard time limit', () => {
    const runAs = { user: 'cvx-agent', sudo: '/usr/bin/sudo' };
    expect(claudeCommand('/usr/bin/claude', ['-p', 'x'], 60_000, runAs)).toEqual({
      file: '/usr/bin/sudo',
      args: ['-n', '-T', '70s', '-u', 'cvx-agent', '--', '/usr/bin/claude', '-p', 'x'],
    });
    expect(claudeCommand('/usr/bin/claude', ['-p', 'x'], 60_000, undefined)).toEqual({
      file: '/usr/bin/claude',
      args: ['-p', 'x'],
    });
  });
});

describe('sudo invocation', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('runs sudo in its own process group with only the allowlisted environment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cvx-runas-'));
    dirs.push(dir);
    const record = join(dir, 'record.json');
    const sudo = join(dir, 'sudo');
    const claude = join(dir, 'claude');
    await writeFile(
      sudo,
      `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const stat = readFileSync('/proc/self/stat', 'utf8');
const pgrp = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, ownGroup: pgrp === process.pid, env: Object.keys(process.env).sort() }));
const rest = args.slice(args.indexOf('--') + 1);
process.stdout.write(execFileSync(rest[0], rest.slice(1)));
`,
      { mode: 0o700 },
    );
    await writeFile(
      claude,
      `#!/usr/bin/env node
const ok = process.env.${RUN_TOKEN_ENV} === ${JSON.stringify(TOKEN)};
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0 }) + '\\n');
process.exit(ok ? 0 : 1);
`,
      { mode: 0o700 },
    );
    process.env['BOARD_TOKEN_FOR_TEST'] = 'must-not-leak';
    try {
      const adapter = new ClaudeCliAdapter({
        bin: claude,
        runAs: { user: 'cvx-agent', sudo },
        extraEnv: { ANTHROPIC_BASE_URL: 'http://gateway' },
      });
      expect(await adapter.run(input(dir))).toEqual({ status: 'succeeded', costUsd: 0 });
    } finally {
      delete process.env['BOARD_TOKEN_FOR_TEST'];
    }
    const recorded = JSON.parse(await readFile(record, 'utf8')) as {
      args: string[];
      ownGroup: boolean;
      env: string[];
    };
    expect(recorded.args.slice(0, 7)).toEqual(['-n', '-T', '15s', '-u', 'cvx-agent', '--', claude]);
    expect(recorded.args.join(' ')).not.toContain(TOKEN);
    expect(recorded.ownGroup).toBe(true);
    expect(recorded.env).toEqual(
      ['ANTHROPIC_BASE_URL', 'ENABLE_TOOL_SEARCH', 'HOME', 'PATH', RUN_TOKEN_ENV].sort(),
    );
  });
});
