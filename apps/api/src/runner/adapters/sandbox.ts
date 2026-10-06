import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { AdapterRunInput } from './types.js';

/**
 * Built-in tools of a coding agent. They only exist inside the sandbox: the root helper starts
 * claude in a transient unit that sees nothing but the issue clone, and the managed settings it
 * mounts keep Bash in the Claude Code sandbox (docs/coding-agents.md).
 */
export const CODE_BUILTIN_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Skill',
  'Edit',
  'Write',
  'Bash',
] as const;

/** Removed from the context of coding agents as well; the managed settings deny them too. */
export const CODE_DENIED_TOOLS = [
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
] as const;

/** Resource limits of one sandboxed run (see the root helper's options). */
export interface SandboxLimits {
  memoryMax: string;
  cpuQuotaPercent: number;
  tasksMax: number;
  diskLimitMb: number;
}

export interface SandboxOptions {
  /** The root helper, started through sudo. */
  helper: string;
  sudo: string;
  limits: SandboxLimits;
  /** Hosts sandboxed commands may reach on top of the helper's package registries. */
  extraDomains: readonly string[];
}

/** Where a coding agent works: the issue clone and the directory its skills were written to. */
export interface CodeRunTarget {
  projectId: string;
  issueKey: string;
  skillsDir: string | null;
}

/** Seconds the unit may run past the runner's own time limit before systemd stops it. */
export const UNIT_GRACE_SECONDS = 30;

/**
 * Part of the run time kept for stopping the unit, handing the clone back, committing and
 * syncing. Together with the 5 minutes of the scheduler's recovery window it covers the usual
 * case; git calls after a run are capped at one minute each, and the cost is stored before them.
 */
export const CODE_RESERVE_MS = 3 * 60_000;

/** The time claude gets in a coding run: the run timeout minus the reserve (at most half). */
export const codeTimeoutMs = (timeoutMs: number): number =>
  timeoutMs - Math.min(CODE_RESERVE_MS, Math.floor(timeoutMs / 2));

/** A budget as the helper accepts it: plain decimal notation, at least one millionth. */
export const budgetArg = (usd: number): string =>
  Math.max(usd, 0.000001)
    .toFixed(6)
    .replace(/\.?0+$/, '');

/** A fresh tag for the helper's status lines, so output of the run cannot imitate them. */
export const newStatusTag = (): string => randomBytes(16).toString('hex');

/**
 * Arguments of `sudo -n <helper> run ...`. They carry ids, limits and flags only; prompt,
 * instructions and secrets reach the unit on stdin (see sandboxStdin).
 */
export function sandboxCommand(
  options: SandboxOptions,
  input: AdapterRunInput,
  target: CodeRunTarget,
  claudeArgs: readonly string[],
  statusTag: string,
): { file: string; args: string[] } {
  const { limits } = options;
  const runtime = Math.ceil(input.timeoutMs / 1000) + UNIT_GRACE_SECONDS;
  const args = [
    '-n',
    options.helper,
    'run',
    '--run-id',
    input.run._id.toHexString(),
    '--project',
    target.projectId,
    '--issue',
    target.issueKey,
    '--status-tag',
    statusTag,
    '--memory-max',
    limits.memoryMax,
    '--cpu-quota',
    String(limits.cpuQuotaPercent),
    '--tasks-max',
    String(limits.tasksMax),
    '--runtime-max-sec',
    String(runtime),
    '--disk-limit-mb',
    String(limits.diskLimitMb),
    ...(target.skillsDir ? ['--skills', target.skillsDir] : []),
    ...options.extraDomains.flatMap((domain) => ['--allow-domain', domain]),
    '--',
    ...claudeArgs,
  ];
  return { file: options.sudo, args };
}

/**
 * The environment block the unit's exec wrapper reads before the stream-json input: one
 * `NAME=<base64 value>` line per variable, then an empty line.
 */
export function environmentBlock(env: Record<string, string>): string {
  const lines = Object.entries(env).map(([name, value]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error(`invalid environment name ${name}`);
    return `${name}=${Buffer.from(value, 'utf8').toString('base64')}`;
  });
  return `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}\n`;
}

/** What the helper reports when the unit has ended. */
export interface SandboxStatus {
  result: string;
  exitCode: number | null;
  diskBytes: number | null;
}

/** Parse a helper status line; null for any other stderr line. */
export function parseStatusLine(
  line: string,
  tag: string,
): { event: string; fields: Record<string, unknown> } | null {
  const prefix = `cvx-agent-run:${tag} `;
  if (!line.startsWith(prefix)) return null;
  try {
    const fields: unknown = JSON.parse(line.slice(prefix.length));
    if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return null;
    const record = fields as Record<string, unknown>;
    return {
      event: typeof record['event'] === 'string' ? record['event'] : 'unknown',
      fields: record,
    };
  } catch {
    return null;
  }
}

/** The finished status from a parsed status line. */
export function toSandboxStatus(fields: Record<string, unknown>): SandboxStatus {
  const number = (value: unknown) => (typeof value === 'number' ? value : null);
  return {
    result: typeof fields['result'] === 'string' ? fields['result'] : 'unknown',
    exitCode: number(fields['exitCode']),
    diskBytes: number(fields['diskBytes']),
  };
}

/** A run error for a unit that systemd or the helper stopped, or null when it ended normally. */
export function sandboxError(status: SandboxStatus | null): string | null {
  if (!status) return 'the sandbox helper did not report a result';
  switch (status.result) {
    case 'success':
    case 'exit-code':
      return null;
    case 'disk-limit':
      return 'the issue workspace exceeded its disk limit';
    case 'disk-check-failed':
      return 'the size of the issue workspace could not be checked';
    case 'oom-kill':
      return 'the run exceeded its memory limit';
    case 'timeout':
      return 'the run exceeded its time limit';
    default:
      return `the sandbox unit ended with ${status.result}`;
  }
}

/**
 * Ask the root helper to hand a clone back to the runner (`agent-run release`); used when a clone
 * is still owned by the agent user after a helper that died mid-run. Resolves false when the helper
 * refuses (for example while a unit still works in the clone), with the helper's exit code
 * and stderr as detail.
 */
export function releaseClone(
  options: Pick<SandboxOptions, 'helper' | 'sudo'>,
  projectId: string,
  issueKey: string,
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      options.sudo,
      ['-n', options.helper, 'release', '--project', projectId, '--issue', issueKey],
      {
        env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) =>
      resolve({ ok: false, detail: `could not start: ${error.message}` }),
    );
    child.on('close', (code) =>
      resolve({ ok: code === 0, detail: `exit ${String(code)} ${stderr.trim()}`.trim() }),
    );
  });
}
