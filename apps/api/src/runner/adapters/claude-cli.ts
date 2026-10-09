import { spawn } from 'node:child_process';
import { lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Adapter, AdapterResult, AdapterRunInput } from './types.js';
import { parseStreamLine, type StreamSummary } from './claude-stream.js';
import { secretEnvNameProblem } from '@conclavix/core';
import { MissingSecretError, type SecretResolver } from '../secrets.js';
import {
  CODE_BUILTIN_TOOLS,
  CODE_DENIED_TOOLS,
  budgetArg,
  codeTimeoutMs,
  environmentBlock,
  newStatusTag,
  parseStatusLine,
  sandboxCommand,
  sandboxError,
  toSandboxStatus,
  type CodeRunTarget,
  type SandboxOptions,
  type SandboxStatus,
} from './sandbox.js';

const KILL_GRACE_MS = 10_000;
/** Time sudo needs for its own HUP, TERM, KILL sequence before the runner kills sudo itself. */
const SUDO_KILL_MARGIN_MS = 15_000;
/** The run token reaches claude only through this variable, never through argv or a file. */
export const RUN_TOKEN_ENV = 'CONCLAVIX_RUN_TOKEN';
/**
 * The run token's variable in coding runs. The sandbox sets CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, under
 * which Claude Code expands variables whose names look like credentials (TOKEN, KEY, AUTH, ...) to
 * an empty string in MCP headers, so the conclavix server would get `Bearer ` and answer 401. This
 * name avoids those patterns; the managed `sandbox.credentials` deny still hides it from Bash.
 */
export const SANDBOX_RUN_TOKEN_ENV = 'CONCLAVIX_RUN_BEARER';
/**
 * Pre-approves every tool of the conclavix MCP server (the same rule the coding sandbox uses).
 * The server decides per run which tools exist (lead tools, code tools), so a list of names here
 * would only drift: under dontAsk a conclavix tool missing from it is silently denied.
 */
export const AGENT_MCP_RULE = 'mcp__conclavix';

/**
 * The only built-in claude tools an agent gets. Read, Grep and Glob stay confined to the run
 * workspace because they are not pre-approved and dontAsk denies anything outside it; Skill runs
 * the skills mounted into the workspace. Everything else (Bash, Write, Edit, WebFetch, ...) is
 * not loaded at all.
 */
export const AGENT_BUILTIN_TOOLS = ['Read', 'Grep', 'Glob', 'Skill'] as const;

/** Denied explicitly as well, so a settings file cannot re-enable them. */
export const DENIED_BUILTIN_TOOLS = [
  'Bash',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
] as const;

/** Workspace settings files claude would load as project settings (allow rules, hooks). */
const WORKSPACE_SETTINGS_FILES = ['settings.json', 'settings.local.json'];

const FORWARDED_ENV = /^(ANTHROPIC_|CLAUDE_CODE_|LANG$|LC_|TZ$)/;

/** The part of the runner's environment that configures claude itself; nothing else is passed on. */
export function claudeEnvFrom(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => FORWARDED_ENV.test(entry[0]) && entry[1] !== undefined,
    ),
  );
}

/** Start claude as a different OS user through a sudoers rule limited to the claude binary. */
export interface RunAs {
  user: string;
  sudo: string;
}

/** The OS user agents run as, refusing the runner's own user because it holds the runner's secrets. */
export function agentRunAs(
  agentUser: string | undefined,
  sudo: string,
  runnerUser: string,
): RunAs | undefined {
  if (agentUser === undefined) {
    return undefined;
  }
  if (agentUser === runnerUser || agentUser === 'root') {
    throw new Error(`AGENT_USER must differ from the runner user and root (got ${agentUser})`);
  }
  return { user: agentUser, sudo };
}

export interface ClaudeCliOptions {
  bin: string;
  extraEnv?: Record<string, string>;
  secrets?: SecretResolver;
  runAs?: RunAs;
  /** The root helper for coding agents; without it they cannot run. */
  sandbox?: SandboxOptions;
}

/** Per-agent environment: the agent's own LLM-gateway key replaces the runner's shared one. */
export function agentEnv(
  input: AdapterRunInput,
  secrets: SecretResolver | undefined,
): Record<string, string> {
  const adapter = input.agent.adapter;
  if (adapter.type !== 'claude_cli' || !adapter.gatewayKeySecret) {
    return {};
  }
  const key = secrets?.(adapter.gatewayKeySecret);
  if (!key) {
    throw new MissingSecretError(adapter.gatewayKeySecret);
  }
  if (/[\r\n]/.test(key)) {
    throw new Error(`secret ${adapter.gatewayKeySecret} contains a line break`);
  }
  return { ANTHROPIC_CUSTOM_HEADERS: `x-litellm-api-key: Bearer ${key}` };
}

/** MCP config for one run; claude expands the token from the environment, so it holds no secret. */
export function mcpConfig(mcpUrl: string, tokenEnv: string = RUN_TOKEN_ENV): string {
  return JSON.stringify({
    mcpServers: {
      conclavix: {
        type: 'http',
        url: mcpUrl,
        headers: { Authorization: `Bearer \${${tokenEnv}}` },
      },
    },
  });
}

/**
 * Build the claude CLI arguments for one run. They hold no prompt or instruction text, because
 * sudo logs the full command line; both reach claude on stdin (see claudeStdin).
 */
export function claudeArgs(input: AdapterRunInput): string[] {
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfig(input.mcpUrl),
    '--max-budget-usd',
    String(input.run.maxCostPerRunUsd),
    '--setting-sources',
    'project',
    '--tools',
    AGENT_BUILTIN_TOOLS.join(','),
    '--permission-mode',
    'dontAsk',
    '--allowedTools',
    [AGENT_MCP_RULE, 'Skill'].join(' '),
    '--disallowedTools',
    DENIED_BUILTIN_TOOLS.join(' '),
  ];
  if (input.agent.adapter.type === 'claude_cli' && input.agent.adapter.model) {
    args.push('--model', input.agent.adapter.model);
  }
  return args;
}

/**
 * The claude flags of a coding agent. Settings come from the managed settings the root helper
 * mounts (permission rules, sandbox, network) and from the run's empty HOME (`user`), never from
 * the clone; the helper accepts only the flags used here. No --allowedTools: the managed
 * allowManagedPermissionRulesOnly makes claude ignore it, and the managed allow rules still apply
 * when the subprocess env scrub forces the permission mode to default.
 */
export function codeClaudeArgs(input: AdapterRunInput): string[] {
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfig(input.mcpUrl, SANDBOX_RUN_TOKEN_ENV),
    '--max-budget-usd',
    budgetArg(input.run.maxCostPerRunUsd),
    '--setting-sources',
    'user',
    '--tools',
    CODE_BUILTIN_TOOLS.join(','),
    '--permission-mode',
    'dontAsk',
    '--disallowedTools',
    CODE_DENIED_TOOLS.join(' '),
  ];
  if (input.agent.adapter.type === 'claude_cli' && input.agent.adapter.model) {
    args.push('--model', input.agent.adapter.model);
  }
  return args;
}

/**
 * The stream-json input for one run: an initialize request carrying the agent instructions as
 * appended system prompt, then the task prompt as the single user message. Closing stdin after
 * it makes claude exit once the turn is done.
 */
export function claudeStdin(input: AdapterRunInput): string {
  const initialize = {
    type: 'control_request',
    request_id: 'conclavix-init',
    request: {
      subtype: 'initialize',
      ...(input.agent.instructions ? { appendSystemPrompt: input.agent.instructions } : {}),
    },
  };
  const message = {
    type: 'user',
    session_id: '',
    parent_tool_use_id: null,
    message: { role: 'user', content: input.prompt },
  };
  return `${JSON.stringify(initialize)}\n${JSON.stringify(message)}\n`;
}

/**
 * Remove settings files from `<workspace>/.claude` so earlier runs cannot widen permissions or
 * install hooks; skills next to them are kept.
 */
export async function removeWorkspaceSettings(workspace: string): Promise<void> {
  const dir = join(workspace, '.claude');
  const stat = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) {
    return;
  }
  if (!stat.isDirectory()) {
    throw new Error(`${dir} is not a directory; refusing to start claude in this workspace`);
  }
  await Promise.all(
    WORKSPACE_SETTINGS_FILES.map((name) => rm(join(dir, name), { recursive: true, force: true })),
  );
}

/**
 * The project secrets of a coding run, checked again before they go into the environment block:
 * a reserved name must never replace a variable the run itself needs.
 */
export function projectSecretEnv(input: AdapterRunInput): Record<string, string> {
  const env = input.secretEnv ?? {};
  for (const name of Object.keys(env)) {
    const problem = secretEnvNameProblem(name);
    if (problem) throw new Error(`project secret ${name}: ${problem}`);
  }
  return env;
}

/** The command that starts claude: directly, or through sudo as the agent user in its own process group. */
export function claudeCommand(
  bin: string,
  args: string[],
  timeoutMs: number,
  runAs: RunAs | undefined,
): { file: string; args: string[] } {
  if (!runAs) {
    return { file: bin, args };
  }
  const hardLimitSeconds = Math.ceil((timeoutMs + KILL_GRACE_MS) / 1000);
  return {
    file: runAs.sudo,
    args: ['-n', '-T', `${hardLimitSeconds}s`, '-u', runAs.user, '--', bin, ...args],
  };
}

/** Derive the run outcome and cost from the stream summary, giving timeouts precedence. */
function toResult(
  summary: StreamSummary,
  exitCode: number | null,
  timedOut: boolean,
): AdapterResult {
  if (timedOut) {
    return { status: 'timed_out', costUsd: summary.costUsd, error: 'run exceeded its time limit' };
  }
  if (summary.resultSeen && !summary.isError && exitCode === 0) {
    return { status: 'succeeded', costUsd: summary.costUsd };
  }
  const reason = summary.errorReason ?? `claude exited with code ${String(exitCode)}`;
  return { status: 'failed', costUsd: summary.costUsd, error: reason };
}

/** How a claude process is started and fed, for the direct and the sandboxed path. */
interface Launch {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  detached: boolean;
  stdin: string;
  killAfterMs: number;
  onStderr: (line: string) => void;
}

interface Exit {
  code: number | null;
  summary: StreamSummary;
  timedOut: boolean;
}

/** Start claude, feed stdin, parse the stream and stop it at the time limit. */
function launch(launchSpec: Launch, input: AdapterRunInput): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const child = spawn(launchSpec.file, launchSpec.args, {
      cwd: launchSpec.cwd,
      env: launchSpec.env,
      detached: launchSpec.detached,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // A claude that exits before reading its input surfaces through its exit code, not EPIPE.
    child.stdin.on('error', () => {});
    child.stdin.end(launchSpec.stdin);
    const summary: StreamSummary = {
      costUsd: 0,
      resultSeen: false,
      isError: false,
      errorReason: null,
      resultText: null,
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      input.onEvent('runner', `time limit of ${input.timeoutMs} ms reached, stopping claude`);
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), launchSpec.killAfterMs).unref();
    }, input.timeoutMs);
    createInterface({ input: child.stdout }).on('line', (line) =>
      parseStreamLine(line, summary, input.onEvent),
    );
    createInterface({ input: child.stderr }).on('line', launchSpec.onStderr);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, summary, timedOut });
    });
  });
}

/**
 * Time the helper gets after SIGTERM to stop the unit and hand the clone back before the runner
 * kills sudo; the unit itself is bounded by its RuntimeMaxSec.
 */
const SANDBOX_KILL_AFTER_MS = 90_000;

/** Runs an agent through the claude CLI in headless mode with a per-run MCP config. */
export class ClaudeCliAdapter implements Adapter {
  constructor(private readonly options: ClaudeCliOptions) {}

  async run(input: AdapterRunInput): Promise<AdapterResult> {
    const env = agentEnv(input, this.options.secrets);
    if (input.code) return this.runSandboxed(input, input.code, env);
    await removeWorkspaceSettings(input.workspace);
    const { runAs } = this.options;
    const command = claudeCommand(this.options.bin, claudeArgs(input), input.timeoutMs, runAs);
    const exit = await launch(
      {
        ...command,
        cwd: input.workspace,
        env: {
          PATH: process.env['PATH'],
          HOME: process.env['HOME'],
          ...this.options.extraEnv,
          ...env,
          ENABLE_TOOL_SEARCH: 'false',
          [RUN_TOKEN_ENV]: input.token,
        },
        detached: runAs !== undefined,
        stdin: claudeStdin(input),
        killAfterMs: runAs ? KILL_GRACE_MS + SUDO_KILL_MARGIN_MS : KILL_GRACE_MS,
        onStderr: (line) => input.onEvent('stderr', line),
      },
      input,
    );
    return withSummary(toResult(exit.summary, exit.code, exit.timedOut), exit.summary);
  }

  /**
   * A coding agent: claude runs through the root helper in a transient unit as the agent user.
   * Every variable claude needs, secrets included, travels on stdin ahead of the prompt; sudo
   * gets a bare environment and argv holds no secret.
   */
  private async runSandboxed(
    input: AdapterRunInput,
    target: CodeRunTarget,
    env: Record<string, string>,
  ): Promise<AdapterResult> {
    const sandbox = this.options.sandbox;
    if (!sandbox) throw new Error('coding agents need AGENT_SANDBOX_HELPER on the runner');
    const tag = newStatusTag();
    const timed = { ...input, timeoutMs: codeTimeoutMs(input.timeoutMs) };
    const command = sandboxCommand(sandbox, timed, target, codeClaudeArgs(timed), tag);
    const reported: { finished: SandboxStatus | null } = { finished: null };
    const exit = await launch(
      {
        ...command,
        cwd: input.workspace,
        env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
        detached: true,
        stdin: `${environmentBlock({
          ...projectSecretEnv(input),
          ...this.options.extraEnv,
          ...env,
          ENABLE_TOOL_SEARCH: 'false',
          [SANDBOX_RUN_TOKEN_ENV]: input.token,
        })}${claudeStdin(input)}`,
        killAfterMs: SANDBOX_KILL_AFTER_MS,
        onStderr: (line) => {
          const status = parseStatusLine(line, tag);
          if (!status) {
            input.onEvent('stderr', line);
            return;
          }
          input.onEvent('runner', `sandbox ${status.event}: ${JSON.stringify(status.fields)}`);
          if (status.event === 'finished') reported.finished = toSandboxStatus(status.fields);
        },
      },
      timed,
    );
    const status = reported.finished;
    const result = toResult(exit.summary, exit.code, exit.timedOut || status?.result === 'timeout');
    const unitError = sandboxError(status);
    const adjusted: AdapterResult =
      unitError && result.status !== 'timed_out'
        ? { status: 'failed', costUsd: result.costUsd, error: unitError }
        : result;
    return { ...withSummary(adjusted, exit.summary), sandbox: status };
  }
}

/** The result text claude reported, for the runner's commit message. */
function withSummary(result: AdapterResult, summary: StreamSummary): AdapterResult {
  return summary.resultText ? { ...result, summary: summary.resultText } : result;
}
