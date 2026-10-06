import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_BUILTIN_TOOLS,
  ClaudeCliAdapter,
  DENIED_BUILTIN_TOOLS,
  claudeArgs,
  removeWorkspaceSettings,
} from '../src/runner/adapters/claude-cli.js';
import type { AdapterRunInput } from '../src/runner/adapters/types.js';

const DANGEROUS = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch'];
const FILE_TOOLS = ['Read', 'Grep', 'Glob'];

const input = (workspace = '/unused') =>
  ({
    workspace,
    prompt: 'test',
    token: 'synthetic',
    mcpUrl: 'http://unused/mcp',
    timeoutMs: 5000,
    run: { maxCostPerRunUsd: 1 },
    agent: { adapter: { type: 'claude_cli' } },
    onEvent: () => {},
  }) as unknown as AdapterRunInput;

const valueOf = (args: string[], flag: string): string => {
  const index = args.indexOf(flag);
  expect(index, `${flag} missing`).toBeGreaterThan(-1);
  return args[index + 1] ?? '';
};

describe('agent tool allowlist', () => {
  const args = claudeArgs(input());

  it('contains no tool that runs commands, writes files or reaches the web', () => {
    for (const tool of DANGEROUS) {
      expect(AGENT_BUILTIN_TOOLS).not.toContain(tool);
    }
    expect(valueOf(args, '--tools').split(',')).toEqual([...AGENT_BUILTIN_TOOLS]);
  });

  it('denies the dangerous tools explicitly as well', () => {
    const denied = valueOf(args, '--disallowedTools').split(' ');
    expect(denied).toEqual([...DENIED_BUILTIN_TOOLS]);
    for (const tool of DANGEROUS) {
      expect(denied).toContain(tool);
    }
  });

  it('uses dontAsk instead of bypassPermissions', () => {
    expect(valueOf(args, '--permission-mode')).toBe('dontAsk');
    expect(args).not.toContain('bypassPermissions');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('pre-approves only the conclavix MCP server and Skill, never unscoped file tools', () => {
    const allowed = valueOf(args, '--allowedTools').split(' ');
    expect(allowed).toEqual(['mcp__conclavix', 'Skill']);
    for (const tool of [...FILE_TOOLS, ...DANGEROUS]) {
      expect(allowed).not.toContain(tool);
    }
  });

  it('ignores user and local settings', () => {
    expect(valueOf(args, '--setting-sources')).toBe('project');
  });
});

describe('workspace settings', () => {
  const dirs: string[] = [];
  const workspace = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cvx-settings-'));
    dirs.push(dir);
    return dir;
  };

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('removes settings files but keeps skills', async () => {
    const dir = await workspace();
    await mkdir(join(dir, '.claude', 'skills', 'demo'), { recursive: true });
    await writeFile(join(dir, '.claude', 'skills', 'demo', 'SKILL.md'), 'demo');
    await writeFile(join(dir, '.claude', 'settings.json'), '{"permissions":{"allow":["Bash"]}}');
    await writeFile(join(dir, '.claude', 'settings.local.json'), '{"hooks":{}}');
    await removeWorkspaceSettings(dir);
    expect(await readdir(join(dir, '.claude'))).toEqual(['skills']);
  });

  it('accepts a workspace without .claude', async () => {
    await expect(removeWorkspaceSettings(await workspace())).resolves.toBeUndefined();
  });

  it('refuses a .claude symlink that could redirect the removal', async () => {
    const dir = await workspace();
    const elsewhere = await workspace();
    await writeFile(join(elsewhere, 'settings.json'), 'keep');
    await symlink(elsewhere, join(dir, '.claude'));
    await expect(removeWorkspaceSettings(dir)).rejects.toThrow(/not a directory/);
    expect(await readdir(elsewhere)).toEqual(['settings.json']);
  });

  it('runs before claude starts', async () => {
    const dir = await workspace();
    await mkdir(join(dir, '.claude'));
    await writeFile(join(dir, '.claude', 'settings.json'), '{"permissions":{"allow":["Read"]}}');
    const bin = join(dir, 'claude');
    await writeFile(
      bin,
      `#!/usr/bin/env node
const { existsSync } = require('node:fs');
process.stdout.write(JSON.stringify({type: 'result', subtype: 'success', total_cost_usd: 0}) + '\\n');
process.exit(existsSync('.claude/settings.json') ? 1 : 0);
`,
      { mode: 0o700 },
    );
    const result = await new ClaudeCliAdapter({ bin }).run(input(dir));
    expect(result).toEqual({ status: 'succeeded', costUsd: 0 });
  });
});
