import { fileURLToPath } from 'node:url';
import { ObjectId } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';
import type { AgentDoc, Database, IssueDoc, RunDoc } from '../src/db.js';
import { claudeArgs, codeClaudeArgs } from '../src/runner/adapters/claude-cli.js';
import {
  environmentBlock,
  parseStatusLine,
  sandboxCommand,
  sandboxError,
  toSandboxStatus,
  UNIT_GRACE_SECONDS,
  budgetArg,
  codeTimeoutMs,
} from '../src/runner/adapters/sandbox.js';
import type { AdapterRunInput } from '../src/runner/adapters/types.js';
import { CodeRuns, commitAuthor, commitMessage } from '../src/runner/code-run.js';
import type { RunEventRecorder } from '../src/runner/events.js';
import type { AuditLog } from '../src/modules/audit/audit.js';
import type { CodeWorkspace } from '../src/modules/workspace/commit.js';

const HELPER_ARGS = fileURLToPath(
  new URL('../../../deploy/agent-sandbox/args.mjs', import.meta.url),
);

const agent = {
  _id: new ObjectId(),
  name: 'Coder',
  instructions: '',
  adapter: { type: 'claude_cli', model: 'opus' },
} as unknown as AgentDoc;
const issue = {
  _id: new ObjectId(),
  projectId: new ObjectId(),
  key: 'COD-9',
  title: 'Build the thing',
} as unknown as IssueDoc;
const run = { _id: new ObjectId(), maxCostPerRunUsd: 2 } as unknown as RunDoc;

const input = {
  run,
  agent,
  issue,
  prompt: 'do it',
  workspace: '/srv/conclavix/workspaces/x/COD',
  mcpUrl: 'http://127.0.0.1:3300/mcp',
  token: 'run-token-value',
  timeoutMs: 30 * 60_000,
  onEvent: () => undefined,
} as AdapterRunInput;

const sandbox = {
  helper: '/usr/local/libexec/conclavix/agent-run.mjs',
  sudo: '/usr/bin/sudo',
  limits: { memoryMax: '4G', cpuQuotaPercent: 200, tasksMax: 512, diskLimitMb: 4096 },
  extraDomains: ['registry.yarnpkg.com'],
};

describe('sandbox command', () => {
  const target = { projectId: issue.projectId.toHexString(), issueKey: 'COD-9', skillsDir: null };

  it('passes ids and limits to the helper, nothing secret', () => {
    const command = sandboxCommand(sandbox, input, target, codeClaudeArgs(input), 'a'.repeat(32));
    expect(command.file).toBe('/usr/bin/sudo');
    expect(command.args.slice(0, 3)).toEqual(['-n', sandbox.helper, 'run']);
    const runtime = command.args[command.args.indexOf('--runtime-max-sec') + 1];
    expect(Number(runtime)).toBe(30 * 60 + UNIT_GRACE_SECONDS);
    expect(command.args).toContain('registry.yarnpkg.com');
    expect(command.args.join(' ')).not.toContain('run-token-value');
    expect(command.args.join(' ')).not.toContain('do it');
  });

  it('builds claude flags the helper accepts', async () => {
    const helper = (await import(HELPER_ARGS)) as {
      parseRunArgs: (argv: string[]) => { claudeArgs: string[] };
    };
    const command = sandboxCommand(sandbox, input, target, codeClaudeArgs(input), 'b'.repeat(32));
    const parsed = helper.parseRunArgs(command.args.slice(2));
    expect(parsed.claudeArgs).toContain('Read,Grep,Glob,Skill,Edit,Write,Bash');
  });

  it('leaves allow rules to the managed settings in coding runs only', () => {
    // claude ignores --allowedTools under allowManagedPermissionRulesOnly; read-only runs need it.
    expect(codeClaudeArgs(input)).not.toContain('--allowedTools');
    const readOnly = claudeArgs(input);
    expect(readOnly[readOnly.indexOf('--allowedTools') + 1]).toBe('mcp__conclavix Skill');
  });

  it('encodes the environment block as base64 lines ended by an empty line', () => {
    const block = environmentBlock({ CLAUDE_CODE_OAUTH_TOKEN: 'secret\nvalue', TZ: 'UTC' });
    expect(block).toBe(
      `CLAUDE_CODE_OAUTH_TOKEN=${Buffer.from('secret\nvalue').toString('base64')}\nTZ=VVRD\n\n`,
    );
    expect(environmentBlock({})).toBe('\n');
    expect(() => environmentBlock({ 'BAD NAME': 'x' })).toThrow();
  });

  it('reads only status lines carrying the run tag', () => {
    const tag = 'c'.repeat(32);
    expect(parseStatusLine(`cvx-agent-run:${'d'.repeat(32)} {"event":"finished"}`, tag)).toBeNull();
    expect(parseStatusLine('plain stderr', tag)).toBeNull();
    const status = parseStatusLine(
      `cvx-agent-run:${tag} {"event":"finished","result":"oom-kill","exitCode":1}`,
      tag,
    );
    expect(status?.event).toBe('finished');
    const finished = toSandboxStatus(status?.fields ?? {});
    expect(sandboxError(finished)).toMatch(/memory/);
    expect(sandboxError({ result: 'exit-code', exitCode: 1, diskBytes: 0 })).toBeNull();
    expect(sandboxError(null)).toMatch(/did not report/);
  });
});

describe('coding run time and budget', () => {
  it('keeps a reserve for commit and sync inside the run timeout', () => {
    expect(codeTimeoutMs(30 * 60_000)).toBe(27 * 60_000);
    expect(codeTimeoutMs(60_000)).toBe(30_000);
  });

  it('formats budgets in plain decimals the helper accepts', () => {
    expect(budgetArg(2)).toBe('2');
    expect(budgetArg(0.123456789)).toBe('0.123457');
    expect(budgetArg(1e-9)).toBe('0.000001');
  });
});

describe('commit message and author', () => {
  it('uses the first line of the result as subject and adds trailers', () => {
    const message = commitMessage(agent, issue, run, {
      status: 'succeeded',
      summary: '\nAdd the parser\nwith tests\u0007',
    });
    const [subject, , ...rest] = message.split('\n');
    expect(subject).toBe('Add the parser');
    expect(message).not.toContain('\u0007');
    expect(rest.join('\n')).toContain(`Conclavix-Run: ${run._id.toHexString()}`);
    expect(message).not.toContain('Conclavix-Run-Status');
  });

  it('falls back to the issue and marks unfinished runs', () => {
    const message = commitMessage(agent, issue, run, { status: 'timed_out' });
    expect(message.split('\n')[0]).toBe('COD-9: Build the thing');
    expect(message).toContain('Conclavix-Run-Status: timed_out');
    expect(
      commitMessage(agent, issue, run, { status: 'succeeded', summary: 'x'.repeat(200) }).split(
        '\n',
      )[0],
    ).toHaveLength(72);
  });

  it('names the agent as author with a per-agent address', () => {
    expect(commitAuthor(agent)).toEqual({
      name: 'Conclavix Coder',
      email: `agent-${agent._id.toHexString()}@conclavix.invalid`,
    });
  });
});

describe('CodeRuns.finish', () => {
  const events = { record: vi.fn() } as unknown as RunEventRecorder;
  const context = {
    projectId: issue.projectId.toHexString(),
    issueKey: 'COD-9',
    skillsDir: null,
    branch: 'cvx/COD-9',
    base: 'a'.repeat(40),
  };
  const setup = (workspace: Partial<CodeWorkspace>) => {
    const updateOne = vi.fn().mockResolvedValue(undefined);
    const database = { collections: { runs: { updateOne } } } as unknown as Database;
    const runs = new CodeRuns(database, {} as AuditLog, workspace as CodeWorkspace);
    return { runs, updateOne };
  };
  const redact = (text: string) => text.replaceAll('run-token-value', '[redacted]');

  it('commits, syncs and stores the outcome on the run', async () => {
    const commitIssueWork = vi.fn().mockResolvedValue({
      branch: 'cvx/COD-9',
      head: 'b'.repeat(40),
      commit: 'b'.repeat(40),
      agentCommits: 0,
      stats: { files: 2, insertions: 10, deletions: 1 },
    });
    const syncIssueBranch = vi.fn().mockResolvedValue({ updated: true });
    const { runs, updateOne } = setup({ commitIssueWork, syncIssueBranch });
    const result = {
      status: 'succeeded' as const,
      costUsd: 1,
      summary: 'token run-token-value',
      sandbox: { result: 'success', exitCode: 0, diskBytes: 1 },
    };
    const code = await runs.finish(context, agent, issue, run, result, events, redact);
    expect(code).toMatchObject({
      commit: 'b'.repeat(40),
      files: 2,
      insertions: 10,
      synced: true,
      error: null,
    });
    expect(commitIssueWork.mock.calls[0]?.[2].message).toContain('[redacted]');
    expect(commitIssueWork.mock.calls[0]?.[2].message).not.toContain('run-token-value');
    expect(syncIssueBranch).toHaveBeenCalledWith(context.projectId, 'COD-9', false);
    expect(updateOne).toHaveBeenCalledWith({ _id: run._id }, { $set: { code } });
  });

  it('commits nothing when the sandbox stopped the run for the disk limit', async () => {
    const commitIssueWork = vi.fn();
    const { runs } = setup({ commitIssueWork });
    const code = await runs.finish(
      context,
      agent,
      issue,
      run,
      {
        status: 'failed',
        costUsd: 1,
        sandbox: { result: 'disk-limit', exitCode: 1, diskBytes: 9 },
      },
      events,
      redact,
    );
    expect(commitIssueWork).not.toHaveBeenCalled();
    expect(code.error).toMatch(/disk-limit/);
  });

  it('leaves the clone alone when the sandbox did not report its end', async () => {
    const commitIssueWork = vi.fn();
    const { runs } = setup({ commitIssueWork });
    const code = await runs.finish(
      context,
      agent,
      issue,
      run,
      { status: 'failed', costUsd: 0 },
      events,
      redact,
    );
    expect(commitIssueWork).not.toHaveBeenCalled();
    expect(code.error).toMatch(/did not report/);
  });

  it('records a refused sync without forcing it', async () => {
    const commitIssueWork = vi.fn().mockResolvedValue({
      branch: 'cvx/COD-9',
      head: 'c'.repeat(40),
      commit: null,
      agentCommits: 2,
      stats: { files: 1, insertions: 1, deletions: 0 },
    });
    const syncIssueBranch = vi.fn().mockRejectedValue(new Error('not a fast-forward'));
    const { runs } = setup({ commitIssueWork, syncIssueBranch });
    const code = await runs.finish(
      context,
      agent,
      issue,
      run,
      {
        status: 'succeeded',
        costUsd: 0,
        sandbox: { result: 'success', exitCode: 0, diskBytes: 0 },
      },
      events,
      redact,
    );
    expect(code.synced).toBe(false);
    expect(code.error).toBe('sync failed: not a fast-forward');
    expect(syncIssueBranch).toHaveBeenCalledTimes(1);
  });
});

describe('CodeRuns.prepare', () => {
  const events = { record: vi.fn() } as unknown as RunEventRecorder;
  const info = { issueKey: 'COD-9', branch: 'cvx/COD-9', head: '', created: false, cloneId: 'x' };
  const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });

  it('reclaims a clone still owned by the agent user and retries once', async () => {
    const createIssueWorkspace = vi.fn().mockRejectedValueOnce(denied).mockResolvedValue(info);
    const reclaim = vi.fn().mockResolvedValue({ ok: true, detail: 'exit 0' });
    const database = {
      inTransaction: vi.fn(async () => false),
    } as unknown as Database;
    const runs = new CodeRuns(
      database,
      {} as AuditLog,
      {
        createIssueWorkspace,
        branchTip: vi.fn().mockResolvedValue(null),
      } as unknown as CodeWorkspace,
      reclaim,
    );
    const context = await runs.prepare(issue, null, events);
    expect(reclaim).toHaveBeenCalledWith(issue.projectId.toHexString(), 'COD-9');
    expect(createIssueWorkspace).toHaveBeenCalledTimes(2);
    expect(context.branch).toBe('cvx/COD-9');
  });

  it('fails when the helper refuses to reclaim', async () => {
    const createIssueWorkspace = vi.fn().mockRejectedValue(denied);
    const runs = new CodeRuns(
      {} as Database,
      {} as AuditLog,
      { createIssueWorkspace } as unknown as CodeWorkspace,
      vi.fn().mockResolvedValue({ ok: false, detail: 'exit 73' }),
    );
    await expect(runs.prepare(issue, null, events)).rejects.toThrow('permission denied');
  });
});
