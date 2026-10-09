import { isIP } from 'node:net';
import { isAbsolute, normalize } from 'node:path';
import { DOMAIN } from './config.mjs';

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

const OBJECT_ID = /^[a-f0-9]{24}$/;
/** Same pattern as issueKeySchema in @conclavix/core. */
export const ISSUE_KEY = /^[A-Z][A-Z0-9]{1,5}-[1-9][0-9]*$/;
const TAG = /^[a-f0-9]{32}$/;
const MEMORY = /^([1-9][0-9]{0,5})([MG])$/;

const integer = (min, max) => (value) => {
  if (!/^[0-9]{1,10}$/.test(value)) return null;
  const number = Number(value);
  return number >= min && number <= max ? number : null;
};

function memoryBytes(value) {
  const match = MEMORY.exec(value);
  if (!match) return null;
  return Number(match[1]) * (match[2] === 'G' ? 1024 ** 3 : 1024 ** 2);
}

/** Options of `agent-run run`; `required` ones must be given, `repeat` ones may appear often. */
const RUN_OPTIONS = {
  '--run-id': { key: 'runId', parse: (v) => (OBJECT_ID.test(v) ? v : null), required: true },
  '--project': { key: 'projectId', parse: (v) => (OBJECT_ID.test(v) ? v : null), required: true },
  '--issue': { key: 'issueKey', parse: (v) => (ISSUE_KEY.test(v) ? v : null), required: true },
  '--status-tag': { key: 'statusTag', parse: (v) => (TAG.test(v) ? v : null), required: true },
  '--skills': {
    key: 'skillsDir',
    parse: (v) => (isAbsolute(v) && normalize(v) === v ? v : null),
  },
  '--memory-max': { key: 'memoryMaxBytes', parse: memoryBytes, fallback: 4 * 1024 ** 3 },
  '--cpu-quota': { key: 'cpuQuotaPercent', parse: integer(10, 6400), fallback: 200 },
  '--tasks-max': { key: 'tasksMax', parse: integer(16, 65536), fallback: 512 },
  '--runtime-max-sec': { key: 'runtimeMaxSec', parse: integer(60, 86400), fallback: 1800 },
  '--disk-limit-mb': {
    key: 'diskLimitBytes',
    parse: (v) => {
      const mb = integer(16, 1024 * 1024)(v);
      return mb === null ? null : mb * 1024 * 1024;
    },
    fallback: 4096 * 1024 * 1024,
  },
  '--allow-domain': {
    key: 'extraDomains',
    parse: (v) => (DOMAIN.test(v) ? v : null),
    repeat: true,
  },
  // A private address of an MCP server the run's connections use; the helper keeps only those
  // inside the configured mcpAllowedAddresses (see agent-run.mjs).
  '--allow-address': {
    key: 'allowAddresses',
    parse: (v) => (isIP(v) !== 0 ? v : null),
    repeat: true,
  },
};

/** Parse the helper's own `--name value` options and apply required and default values. */
function parseOptions(own) {
  const options = { extraDomains: [], allowAddresses: [] };
  const seen = new Set();
  for (let i = 0; i < own.length; i += 2) {
    const name = own[i];
    const spec = RUN_OPTIONS[name];
    if (!spec) throw new UsageError(`unknown option ${name}`);
    if (i + 1 >= own.length) throw new UsageError(`${name} needs a value`);
    if (seen.has(name) && !spec.repeat) throw new UsageError(`${name} given twice`);
    seen.add(name);
    const value = spec.parse(own[i + 1]);
    if (value === null) throw new UsageError(`invalid value for ${name}`);
    if (spec.repeat) options[spec.key].push(value);
    else options[spec.key] = value;
  }
  for (const [name, spec] of Object.entries(RUN_OPTIONS)) {
    if (options[spec.key] !== undefined) continue;
    if (spec.required) throw new UsageError(`${name} is required`);
    if (spec.fallback !== undefined) options[spec.key] = spec.fallback;
  }
  return options;
}

/**
 * Parse `run <options> -- <claude flags>`. Every option takes exactly one value; unknown options,
 * repeated single options and malformed values are refused. In probe mode the arguments after
 * `--` go to the probe script unchecked.
 */
export function parseRunArgs(argv, { probe = false } = {}) {
  if (argv[0] !== 'run') throw new UsageError('usage: agent-run run <options> -- <claude flags>');
  const separator = argv.indexOf('--');
  if (separator === -1) throw new UsageError('missing -- before the claude flags');
  const options = parseOptions(argv.slice(1, separator));
  if (options.extraDomains.length > 50) throw new UsageError('too many --allow-domain values');
  if (options.allowAddresses.length > 16) throw new UsageError('too many --allow-address values');
  const rest = argv.slice(separator + 1);
  options.claudeArgs = probe ? rest : validateClaudeArgs(rest);
  options.mcpServers = probe ? [] : mcpServerNames(options.claudeArgs);
  return options;
}

/**
 * Parse `release --project <id> --issue <KEY>`: hand a clone left with the agent user (the helper
 * died during a run) back to the runner.
 */
export function parseReleaseArgs(argv) {
  if (argv[0] !== 'release' || argv.length !== 5) {
    throw new UsageError('usage: agent-run release --project <id> --issue <KEY>');
  }
  const values = { '--project': argv[2], '--issue': argv[4] };
  if (argv[1] !== '--project' || argv[3] !== '--issue') throw new UsageError('unknown option');
  const projectId = RUN_OPTIONS['--project'].parse(values['--project']);
  const issueKey = RUN_OPTIONS['--issue'].parse(values['--issue']);
  if (projectId === null || issueKey === null) throw new UsageError('invalid project or issue');
  return { projectId, issueKey };
}

/** Refuse limits above the configured maxima. */
export function assertWithinLimits(options, maxLimits) {
  for (const key of Object.keys(maxLimits)) {
    if (options[key] > maxLimits[key]) {
      throw new UsageError(
        `${key} ${options[key]} exceeds the configured maximum ${maxLimits[key]}`,
      );
    }
  }
}

const BUILTIN_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Skill', 'Edit', 'Write', 'Bash']);
const MODEL = /^[A-Za-z0-9][\w.:/@[\]-]{0,119}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const SERVER_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
/** Header values of connection servers: only a reference claude expands from the environment. */
const HEADER_REFERENCE = /^\$\{CONCLAVIX_MCP_HEADER_([1-9]|[12][0-9]|3[0-2])\}$/;
const MAX_SERVERS = 9;
const MAX_HEADERS = 8;

function urlOf(value) {
  try {
    return typeof value === 'string' ? new URL(value) : null;
  } catch {
    return null;
  }
}

/** The board's own server: plain HTTP on loopback. */
function boardServerValid(server) {
  const url = urlOf(server.url);
  return url !== null && url.protocol === 'http:' && LOOPBACK.has(url.hostname);
}

/**
 * A connection's server: http(s) without credentials in the URL, header values only as
 * references, so no secret ever stands in argv.
 */
function connectionServerValid(server) {
  // claude would expand ${NAME} in the URL from the run's environment.
  if (typeof server.url !== 'string' || server.url.includes('$')) return false;
  const url = urlOf(server.url);
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    return false;
  }
  const headers = server.headers ?? {};
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) return false;
  const entries = Object.entries(headers);
  return (
    entries.length <= MAX_HEADERS &&
    entries.every(
      ([name, value]) =>
        HEADER_NAME.test(name) && typeof value === 'string' && HEADER_REFERENCE.test(value),
    )
  );
}

/**
 * The MCP config may hold only HTTP servers (a stdio server would start a program): `conclavix`
 * on loopback, and up to eight connection servers (docs/connections.md). Returns the server
 * names, or null when the config is refused.
 */
export function mcpConfigServers(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const servers = parsed?.mcpServers;
  if (typeof servers !== 'object' || servers === null || Object.keys(parsed).length !== 1) {
    return null;
  }
  const names = Object.keys(servers);
  if (names.length > MAX_SERVERS) return null;
  const valid = names.every((name) => {
    const server = servers[name];
    if (!SERVER_NAME.test(name) || server?.type !== 'http') return false;
    return name === 'conclavix' ? boardServerValid(server) : connectionServerValid(server);
  });
  return valid ? names : null;
}

const mcpConfigValid = (value) => mcpConfigServers(value) !== null;

/** The server names of the validated claude flags' --mcp-config. */
function mcpServerNames(claudeArgs) {
  const index = claudeArgs.indexOf('--mcp-config');
  return index === -1 ? [] : (mcpConfigServers(claudeArgs[index + 1]) ?? []);
}

/**
 * The claude flags a run may use, with a check of each value. Flags that widen access
 * (--add-dir, --settings, --dangerously-skip-permissions, --plugin-dir, ...) are not here.
 */
const CLAUDE_FLAGS = {
  '-p': null,
  '--verbose': null,
  '--no-session-persistence': null,
  '--strict-mcp-config': null,
  '--input-format': (v) => v === 'stream-json',
  '--output-format': (v) => v === 'stream-json',
  '--permission-mode': (v) => v === 'dontAsk',
  '--setting-sources': (v) => v === 'user',
  '--mcp-config': mcpConfigValid,
  '--max-budget-usd': (v) => /^\d{1,4}(\.\d{1,6})?$/.test(v) && Number(v) > 0,
  '--model': (v) => MODEL.test(v),
  '--tools': (v) => v.split(',').every((tool) => BUILTIN_TOOLS.has(tool)),
  // Only restrict: allow rules come from the managed settings alone.
  '--disallowedTools': (v) => v.length <= 2000 && !v.startsWith('-'),
};

const REQUIRED_FLAGS = ['-p', '--strict-mcp-config', '--permission-mode', '--setting-sources'];

/** Validate the claude flags against CLAUDE_FLAGS; returns them unchanged. */
export function validateClaudeArgs(args) {
  const seen = new Set();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (!(flag in CLAUDE_FLAGS)) throw new UsageError(`claude flag ${flag} is not allowed`);
    if (seen.has(flag)) throw new UsageError(`claude flag ${flag} given twice`);
    seen.add(flag);
    const check = CLAUDE_FLAGS[flag];
    if (check === null) continue;
    const value = args[i + 1];
    if (value === undefined || !check(value)) {
      throw new UsageError(`invalid value for claude flag ${flag}`);
    }
    i += 1;
  }
  for (const flag of REQUIRED_FLAGS) {
    if (!seen.has(flag)) throw new UsageError(`claude flag ${flag} is required`);
  }
  return args;
}
