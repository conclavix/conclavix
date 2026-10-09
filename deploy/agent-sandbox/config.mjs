import { constants } from 'node:fs';
import { access, lstat, readFile, realpath, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, isAbsolute, normalize } from 'node:path';

/** Root-owned configuration; every field is optional and falls back to DEFAULTS. */
export const CONFIG_PATH = '/etc/conclavix/agent-sandbox.json';

const MIB = 1024 * 1024;

export const DEFAULTS = Object.freeze({
  /** WORKSPACE_ROOT of the API and the runner: bare repositories and issue clones. */
  codeRoot: '/srv/conclavix/code',
  /** WORKSPACES_ROOT of the runner: per-agent run directories with the materialised skills. */
  runnerWorkspacesRoot: '/srv/conclavix/workspaces',
  /** The OS user claude runs as. */
  agentUser: 'cvx-agent',
  /** Owner of a clone between runs; the runner commits as this user. */
  ownerUser: 'cvx-runner',
  /** Group shared by the API, the runner and nobody else; clones belong to it between runs. */
  codeGroup: 'cvx-code',
  claudeBin: '/usr/bin/claude',
  /**
   * The wrapper the unit starts from this path; it reads the environment from stdin and execs
   * claude. Root-owned on a filesystem mounted without noexec (checked before every run).
   */
  execWrapper: '/usr/local/libexec/conclavix/agent-exec.sh',
  /** Root-owned per-run directories with the managed settings (bound to /etc/claude-code). */
  policyRoot: '/run/conclavix-agent',
  /** Must exist on the host, so the unit can mount the per-run policy over it. */
  managedSettingsDir: '/etc/claude-code',
  /** Hosts sandboxed commands may reach; a run can add hosts from the instance setting. */
  allowedDomains: ['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org'],
  /** Directories replaced by an empty read-only tmpfs inside the unit. */
  hiddenPaths: [
    '/srv',
    '/opt',
    '/var/lib/docker',
    '/var/lib/containerd',
    '/var/backups',
    '/mnt',
    '/media',
  ],
  /** Paths made inaccessible inside the unit; missing ones are ignored. */
  inaccessiblePaths: ['/etc/conclavix', '/run/docker.sock', '/run/containerd', '/var/log'],
  /** Destinations the claude process may not connect to (it still reaches loopback). */
  deniedAddresses: [
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '169.254.0.0/16',
    '100.64.0.0/10',
    'fc00::/7',
    'fe80::/10',
  ],
  /**
   * Private networks (CIDR) a run may open for the MCP servers of its connections. Empty: a
   * coding run reaches no MCP server on a private address (docs/connections.md).
   */
  mcpAllowedAddresses: [],
  /** Upper bounds; a run asking for more is refused. */
  maxLimits: {
    memoryMaxBytes: 16 * 1024 * MIB,
    cpuQuotaPercent: 800,
    tasksMax: 4096,
    runtimeMaxSec: 4 * 3600,
    diskLimitBytes: 50 * 1024 * MIB,
  },
  /** How often the clone's size is checked while the unit runs. */
  diskCheckIntervalSec: 30,
});

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const absolutePath = (value) =>
  typeof value === 'string' && isAbsolute(value) && normalize(value) === value && value !== '/';

/** An IPv4 or IPv6 network in CIDR notation. */
export function cidr(value) {
  if (typeof value !== 'string') return false;
  const [address, prefix, ...rest] = value.split('/');
  const family = isIP(address ?? '');
  if (rest.length > 0 || family === 0 || !/^\d{1,3}$/.test(prefix ?? '')) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

const userName = (value) => typeof value === 'string' && /^[a-z_][a-z0-9_-]{0,31}$/.test(value);

export const DOMAIN = /^(?=.{1,253}$)(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const CHECKS = {
  codeRoot: absolutePath,
  runnerWorkspacesRoot: absolutePath,
  agentUser: userName,
  ownerUser: userName,
  codeGroup: userName,
  claudeBin: absolutePath,
  execWrapper: absolutePath,
  policyRoot: absolutePath,
  managedSettingsDir: absolutePath,
  allowedDomains: (value) => Array.isArray(value) && value.every((d) => DOMAIN.test(d)),
  hiddenPaths: (value) => Array.isArray(value) && value.every(absolutePath),
  inaccessiblePaths: (value) => Array.isArray(value) && value.every(absolutePath),
  deniedAddresses: (value) =>
    Array.isArray(value) && value.every((a) => /^[0-9a-f:.]+\/\d{1,3}$/i.test(a)),
  mcpAllowedAddresses: (value) => Array.isArray(value) && value.every(cidr),
  maxLimits: (value) =>
    isPlainObject(value) &&
    Object.entries(value).every(
      ([key, limit]) => key in DEFAULTS.maxLimits && Number.isSafeInteger(limit) && limit > 0,
    ),
  diskCheckIntervalSec: (value) => Number.isSafeInteger(value) && value >= 5 && value <= 3600,
};

/** Merge a parsed configuration document over DEFAULTS, rejecting unknown or invalid keys. */
export function mergeConfig(document) {
  if (!isPlainObject(document)) throw new Error('the configuration must be a JSON object');
  const config = { ...DEFAULTS, maxLimits: { ...DEFAULTS.maxLimits } };
  for (const [key, value] of Object.entries(document)) {
    const check = CHECKS[key];
    if (!check) throw new Error(`unknown configuration key ${key}`);
    if (!check(value)) throw new Error(`invalid configuration value for ${key}`);
    config[key] = key === 'maxLimits' ? { ...DEFAULTS.maxLimits, ...value } : value;
  }
  if (config.codeRoot === config.runnerWorkspacesRoot) {
    throw new Error('codeRoot and runnerWorkspacesRoot must differ');
  }
  return config;
}

/**
 * Load the configuration. A missing file means the defaults; an existing one must be a regular
 * file owned by root and writable by nobody else, like its directory.
 */
export async function loadConfig(path = CONFIG_PATH) {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return mergeConfig({});
    throw error;
  }
  const dir = await stat(path.slice(0, path.lastIndexOf('/')) || '/');
  for (const [what, entry] of [
    [path, info],
    ['its directory', dir],
  ]) {
    if (entry.uid !== 0 || (entry.mode & 0o022) !== 0) {
      throw new Error(`${what} must be owned by root and not writable by group or others`);
    }
  }
  if (!info.isFile()) throw new Error(`${path} is not a regular file`);
  return mergeConfig(JSON.parse(await readFile(path, 'utf8')));
}

/** Parse /etc/passwd or /etc/group content into name -> the fields after the password. */
export function parseIdFile(content) {
  const entries = new Map();
  for (const line of content.split('\n')) {
    const fields = line.split(':');
    if (fields.length < 4 || !/^\d+$/.test(fields[2] ?? '')) continue;
    entries.set(fields[0], { id: Number(fields[2]), next: fields[3] ?? '' });
  }
  return entries;
}

/** Numeric ids of the configured users and group; root ids are refused. */
export async function resolveIds(config, files = { passwd: '/etc/passwd', group: '/etc/group' }) {
  const users = parseIdFile(await readFile(files.passwd, 'utf8'));
  const groups = parseIdFile(await readFile(files.group, 'utf8'));
  const user = (name) => {
    const entry = users.get(name);
    if (!entry || !/^\d+$/.test(entry.next)) throw new Error(`unknown user ${name}`);
    return { uid: entry.id, gid: Number(entry.next) };
  };
  const agent = user(config.agentUser);
  const owner = user(config.ownerUser);
  const code = groups.get(config.codeGroup);
  if (!code) throw new Error(`unknown group ${config.codeGroup}`);
  const ids = { agent, owner, codeGid: code.id };
  const members = code.next.split(',').filter(Boolean);
  if ([agent.uid, agent.gid, owner.uid, ids.codeGid].includes(0)) {
    throw new Error('the agent user, the owner and the code group must not be root');
  }
  if (agent.uid === owner.uid || agent.gid === ids.codeGid || members.includes(config.agentUser)) {
    throw new Error('the agent user must differ from the owner and must not use the code group');
  }
  return ids;
}

/**
 * Refuse a program the unit would start unless only root can change it: no symlink on the way, a
 * root-owned regular file not writable by group or others, every directory above it root-owned and
 * not writable by others (sticky directories such as /tmp excepted, where nobody else can rename
 * root's entries), and executable here, which also fails on a filesystem mounted noexec.
 */
export async function assertRootProgram(path) {
  if ((await realpath(path)) !== path) throw new Error(`${path} must not contain a symlink`);
  const info = await lstat(path);
  if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) {
    throw new Error(`${path} must be a root-owned file not writable by group or others`);
  }
  // The unit runs it as the agent user, for whom root's access check below says nothing.
  if ((info.mode & 0o005) !== 0o005) {
    throw new Error(`${path} must be readable and executable by others`);
  }
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    const entry = await lstat(dir);
    const sticky = (entry.mode & 0o1000) !== 0;
    if (entry.uid !== 0 || (!sticky && (entry.mode & 0o022) !== 0)) {
      throw new Error(`${dir} must be owned by root and not writable by group or others`);
    }
    if (dir === '/') break;
  }
  try {
    await access(path, constants.X_OK);
  } catch {
    throw new Error(`${path} must be executable and on a filesystem mounted without noexec`);
  }
}
