import { z } from 'zod';
import { secretEnvNameProblem } from './secret.js';

/**
 * A program on the runner host that sandboxed coding runs may execute by path, for example a
 * mongod for integration tests (CODE_SANDBOX_TOOLS, docs/coding-agents.md). The name becomes an
 * environment variable inside the sandbox that holds the path; neither is a secret.
 */
export interface SandboxTool {
  name: string;
  path: string;
}

export const SANDBOX_TOOL_LIMITS = { count: 16, nameLength: 64, pathLength: 512 } as const;

/** Upper-case, ends in _BIN; same pattern as the root helper's (deploy/agent-sandbox/args.mjs). */
export const SANDBOX_TOOL_NAME = /^[A-Z][A-Z0-9_]*_BIN$/;

/**
 * Absolute and normalised, from a conservative character set: the value ends up in a systemd
 * Environment= property, where spaces, quotes and % specifiers would need escaping.
 */
export const SANDBOX_TOOL_PATH = /^(\/[A-Za-z0-9_+-][A-Za-z0-9._+-]*)+$/;

/** Why `name` cannot name a sandbox tool, or null when it can. */
export function sandboxToolNameProblem(name: string): string | null {
  if (!SANDBOX_TOOL_NAME.test(name) || name.length > SANDBOX_TOOL_LIMITS.nameLength) {
    return `${name}: must be upper-case letters, digits and _, ending in _BIN`;
  }
  const reserved = secretEnvNameProblem(name);
  return reserved ? `${name}: ${reserved}` : null;
}

/** Why `path` cannot be a sandbox tool's path, or null when it can. */
export function sandboxToolPathProblem(path: string): string | null {
  if (path.length > SANDBOX_TOOL_LIMITS.pathLength || !SANDBOX_TOOL_PATH.test(path)) {
    return 'must be an absolute path of letters, digits and . _ + -';
  }
  if (path.split('/').some((part) => part === '.' || part === '..')) {
    return 'must not contain . or .. components';
  }
  return null;
}

/** Parse `NAME=/path,NAME=/path`; blanks are dropped, everything else must be valid. */
export function parseSandboxTools(value: string): { tools: SandboxTool[]; problems: string[] } {
  const tools: SandboxTool[] = [];
  const problems: string[] = [];
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    const name = separator === -1 ? entry : entry.slice(0, separator);
    const path = separator === -1 ? '' : entry.slice(separator + 1);
    const problem =
      separator === -1
        ? `${entry}: must look like NAME_BIN=/absolute/path`
        : (sandboxToolNameProblem(name) ??
          (sandboxToolPathProblem(path) ? `${name}: ${sandboxToolPathProblem(path)}` : null));
    if (problem) problems.push(problem);
    else if (tools.some((tool) => tool.name === name)) problems.push(`${name}: given twice`);
    else tools.push({ name, path });
  }
  if (tools.length > SANDBOX_TOOL_LIMITS.count) {
    problems.push(`at most ${SANDBOX_TOOL_LIMITS.count} tools`);
  }
  return { tools, problems };
}

/** CODE_SANDBOX_TOOLS: comma-separated NAME_BIN=/absolute/path pairs, empty by default. */
export const sandboxToolsSchema = z
  .string()
  .default('')
  .transform((value, context) => {
    const { tools, problems } = parseSandboxTools(value);
    for (const message of problems) context.addIssue({ code: 'custom', message });
    return tools;
  });
