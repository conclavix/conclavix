import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObjectId } from 'mongodb';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentDoc, IssueDoc, RunDoc } from '../src/db.js';
import {
  ClaudeCliAdapter,
  RUN_TOKEN_ENV,
  SANDBOX_RUN_TOKEN_ENV,
  codeClaudeArgs,
} from '../src/runner/adapters/claude-cli.js';
import type { AdapterRunInput } from '../src/runner/adapters/types.js';

const SANDBOX_DIR = fileURLToPath(new URL('../../../deploy/agent-sandbox/', import.meta.url));
const TOKEN = 'cvx_run_synthetic-run-token';

/**
 * The name segments Claude Code treats as credentials when CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is set;
 * a variable named like this is expanded to an empty string in MCP headers.
 */
const CREDENTIAL_NAME =
  /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|KEY|AUTH|COOKIE|PAT|DSN|WEBHOOK|CREDENTIALS?|CREDS|JWT|PWD|PASS)S?(?=$|[_0-9])/i;

const input = (workspace: string): AdapterRunInput =>
  ({
    run: { _id: new ObjectId(), maxCostPerRunUsd: 2 } as unknown as RunDoc,
    agent: {
      _id: new ObjectId(),
      name: 'Coder',
      instructions: '',
      adapter: { type: 'claude_cli' },
    } as unknown as AgentDoc,
    issue: { _id: new ObjectId(), key: 'COD-9' } as unknown as IssueDoc,
    prompt: 'do it',
    workspace,
    mcpUrl: 'http://127.0.0.1:3300/mcp',
    token: TOKEN,
    timeoutMs: 60_000,
    code: { projectId: 'a'.repeat(24), issueKey: 'COD-9', skillsDir: null },
    onEvent: () => undefined,
  }) as AdapterRunInput;

/** The allowlist of variable names agent-exec.sh accepts from stdin. */
async function wrapperAllowlist(): Promise<RegExp> {
  const script = await readFile(join(SANDBOX_DIR, 'agent-exec.sh'), 'utf8');
  const match = /^readonly allowed='([^']+)'$/m.exec(script);
  if (!match?.[1]) throw new Error('allowlist not found in agent-exec.sh');
  return new RegExp(match[1]);
}

describe('run token in coding runs', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('uses a name the subprocess env scrub still expands in MCP headers', () => {
    expect(RUN_TOKEN_ENV).toMatch(CREDENTIAL_NAME);
    expect(SANDBOX_RUN_TOKEN_ENV).not.toMatch(CREDENTIAL_NAME);
    const args = codeClaudeArgs(input('/tmp'));
    const config = JSON.parse(args[args.indexOf('--mcp-config') + 1] ?? '{}') as {
      mcpServers: { conclavix: { headers: Record<string, string> } };
    };
    expect(config.mcpServers.conclavix.headers).toEqual({
      Authorization: `Bearer \${${SANDBOX_RUN_TOKEN_ENV}}`,
    });
  });

  it('is accepted by the exec wrapper and hidden from sandboxed commands', async () => {
    expect((await wrapperAllowlist()).test(SANDBOX_RUN_TOKEN_ENV)).toBe(true);
    const policy = (await import(join(SANDBOX_DIR, 'policy.mjs'))) as { SECRET_ENV: string[] };
    expect(policy.SECRET_ENV).toContain(SANDBOX_RUN_TOKEN_ENV);
  });

  it('travels on stdin under that name, never in argv', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cvx-run-token-'));
    dirs.push(dir);
    const sudo = join(dir, 'sudo');
    await writeFile(
      sudo,
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${dir}/argv'\ncat > '${dir}/stdin'\nexit 1\n`,
      { mode: 0o700 },
    );
    const adapter = new ClaudeCliAdapter({
      bin: '/usr/bin/false',
      sandbox: {
        helper: '/usr/local/libexec/conclavix/agent-run.mjs',
        sudo,
        limits: { memoryMax: '4G', cpuQuotaPercent: 200, tasksMax: 512, diskLimitMb: 4096 },
        extraDomains: [],
      },
    });
    const result = await adapter.run(input(dir));
    expect(result.status).toBe('failed');

    const stdin = await readFile(join(dir, 'stdin'), 'utf8');
    const block = stdin.slice(0, stdin.indexOf('\n\n'));
    const env = Object.fromEntries(
      block.split('\n').map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), Buffer.from(line.slice(at + 1), 'base64').toString('utf8')];
      }),
    );
    expect(env[SANDBOX_RUN_TOKEN_ENV]).toBe(TOKEN);
    expect(env).not.toHaveProperty(RUN_TOKEN_ENV);
    const allowed = await wrapperAllowlist();
    expect(Object.keys(env).filter((name) => !allowed.test(name))).toEqual([]);

    const argv = await readFile(join(dir, 'argv'), 'utf8');
    expect(argv).not.toContain(TOKEN);
    expect(argv).toContain(`Bearer \${${SANDBOX_RUN_TOKEN_ENV}}`);
  });
});
