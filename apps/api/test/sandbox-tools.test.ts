import { fileURLToPath } from 'node:url';
import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import type { AgentDoc, IssueDoc, RunDoc } from '../src/db.js';
import type { OrgPosition } from '../src/modules/org/position.js';
import { codeClaudeArgs } from '../src/runner/adapters/claude-cli.js';
import { sandboxCommand, usableSandboxTools } from '../src/runner/adapters/sandbox.js';
import type { AdapterRunInput } from '../src/runner/adapters/types.js';
import { buildPrompt, SILENT_RUN_HINT } from '../src/runner/prompt.js';

const HELPER_ARGS = fileURLToPath(
  new URL('../../../deploy/agent-sandbox/args.mjs', import.meta.url),
);

const [MONGOD, CHROME] = [
  { name: 'MONGOD_BIN', path: '/usr/local/lib/test-tools/mongodb/bin/mongod' },
  { name: 'CHROME_BIN', path: '/usr/local/lib/test-tools/chrome/chrome-headless-shell' },
] as const;
const TOOLS = [MONGOD, CHROME];

const agent = {
  _id: new ObjectId(),
  name: 'Coder',
  role: 'engineer',
  instructions: '',
  adapter: { type: 'claude_cli' },
} as unknown as AgentDoc;
const issue = { _id: new ObjectId(), key: 'COD-1', title: 'Test it' } as unknown as IssueDoc;
const position: OrgPosition = {
  isLead: false,
  delegators: [],
  delegates: [],
  delegatesNotInProject: [],
  reportsTo: [],
  notifications: [],
};

describe('sandbox tools on the runner', () => {
  const input = {
    run: { _id: new ObjectId(), maxCostPerRunUsd: 1 } as unknown as RunDoc,
    agent,
    issue,
    prompt: 'p',
    workspace: '/w',
    mcpUrl: 'http://127.0.0.1:3300/mcp',
    token: 't',
    timeoutMs: 600_000,
    onEvent: () => undefined,
  } as AdapterRunInput;
  const sandbox = {
    helper: '/usr/local/libexec/conclavix/agent-run.mjs',
    sudo: '/usr/bin/sudo',
    limits: { memoryMax: '4G', cpuQuotaPercent: 200, tasksMax: 512, diskLimitMb: 4096 },
    extraDomains: [],
    tools: TOOLS,
  };
  const target = { projectId: 'b'.repeat(24), issueKey: 'COD-1', skillsDir: null };

  it('passes each tool as --tool NAME=PATH, which the helper parses back', async () => {
    const command = sandboxCommand(sandbox, input, target, codeClaudeArgs(input), 'a'.repeat(32));
    const index = command.args.indexOf('--tool');
    expect(command.args.slice(index, index + 4)).toEqual([
      '--tool',
      `MONGOD_BIN=${MONGOD.path}`,
      '--tool',
      `CHROME_BIN=${CHROME.path}`,
    ]);
    const helper = (await import(HELPER_ARGS)) as {
      parseRunArgs: (argv: string[]) => { tools: { name: string; path: string }[] };
    };
    expect(helper.parseRunArgs(command.args.slice(2)).tools).toEqual(TOOLS);
  });

  it('passes no --tool without tools', () => {
    const command = sandboxCommand(
      { ...sandbox, tools: [] },
      input,
      target,
      codeClaudeArgs(input),
      'a'.repeat(32),
    );
    expect(command.args).not.toContain('--tool');
  });

  it('leaves out tools that are not executable on the runner', async () => {
    const result = await usableSandboxTools(TOOLS, async (path) => {
      if (path.includes('chrome')) throw new Error('ENOENT');
    });
    expect(result.usable.map((tool) => tool.name)).toEqual(['MONGOD_BIN']);
    expect(result.missing.map((tool) => tool.name)).toEqual(['CHROME_BIN']);
    const real = await usableSandboxTools([
      { name: 'SH_BIN', path: '/bin/sh' },
      { name: 'NONE_BIN', path: '/nonexistent/cvx-tool' },
    ]);
    expect(real.usable.map((tool) => tool.name)).toEqual(['SH_BIN']);
  });
});

describe('run prompt', () => {
  it('lists the tools for coding runs only', () => {
    const coding = buildPrompt(agent, issue, 'assigned', position, { code: true, tools: TOOLS });
    expect(coding).toContain(`- MONGOD_BIN=${MONGOD.path} is set`);
    expect(coding).toContain('"$MONGOD_BIN"');
    expect(coding).toContain('their directories cannot be listed');
    const readOnly = buildPrompt(agent, issue, 'assigned', position, { tools: TOOLS });
    expect(readOnly).not.toContain('MONGOD_BIN');
    const none = buildPrompt(agent, issue, 'assigned', position, { code: true, tools: [] });
    expect(none).not.toContain('Test tools');
  });

  it('tells every agent that a silent run escalates and to comment when blocked', () => {
    const prompt = buildPrompt(agent, issue, 'assigned', position);
    expect(prompt).toContain(SILENT_RUN_HINT.join('\n'));
    expect(prompt).toMatch(/escalates to whoever delegated it/);
    expect(prompt).toMatch(/add_comment before you stop/);
  });
});
