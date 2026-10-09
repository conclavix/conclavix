#!/usr/bin/node
// Root helper of the Conclavix runner: runs one coding-agent turn in a transient systemd unit
// that sees only its own issue clone. Installed root-owned in /usr/local/libexec/conclavix and
// called through sudo (deploy/sudoers/conclavix-runner). See docs/coding-agents.md.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { BlockList, isIP } from 'node:net';
import { join } from 'node:path';
import { assertWithinLimits, parseReleaseArgs, parseRunArgs, UsageError } from './args.mjs';
import {
  assertRootProgram,
  assertToolProgram,
  CONFIG_PATH,
  loadConfig,
  resolveIds,
} from './config.mjs';
import {
  clonePath,
  managedSettings,
  mergeManaged,
  policyDir,
  probePath,
  systemdRunArgs,
  unitName,
} from './policy.mjs';
import { applyRegistry } from './registry.mjs';
import { assertRealDirectoryBelow, chownTree, diskUsage } from './tree.mjs';

const SYSTEMCTL = '/usr/bin/systemctl';
/** Unit states in which processes of the unit may still run. */
const ACTIVE_STATES = new Set(['active', 'activating', 'deactivating', 'reloading', 'refreshing']);
const SYSTEMD_RUN = '/usr/bin/systemd-run';

/** Exit codes besides claude's own. */
export const EXIT = {
  usage: 64,
  internal: 70,
  diskBefore: 75,
  inUse: 73,
  timeout: 124,
  diskLimit: 125,
};

function status(tag, fields) {
  process.stderr.write(`cvx-agent-run:${tag} ${JSON.stringify(fields)}\n`);
}

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: options.stdio ?? 'ignore',
      env: { PATH: '/usr/bin:/bin' },
    });
    let out = '';
    child.stdout?.on('data', (chunk) => (out += chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, out }));
  });
}

async function unitLoaded(name) {
  const { out } = await run(SYSTEMCTL, ['show', '-p', 'LoadState', '--value', `${name}.service`], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return out.trim() === 'loaded';
}

/**
 * True when an agent unit (of any run) that may still have processes works in `clone`. Failed
 * units of earlier runs for the clone are reset on the way.
 */
async function cloneInUse(clone) {
  const { out } = await run(
    SYSTEMCTL,
    ['list-units', '--all', '--plain', '--no-legend', '--type=service', 'cvx-agent-*'],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  for (const unit of out
    .split('\n')
    .map((line) => line.split(/\s+/)[0])
    .filter(Boolean)) {
    const shown = await run(
      SYSTEMCTL,
      ['show', '-p', 'WorkingDirectory', '-p', 'ActiveState', unit],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const fields = Object.fromEntries(
      shown.out
        .trim()
        .split('\n')
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    if (fields['WorkingDirectory'] !== clone) continue;
    if (ACTIVE_STATES.has(fields['ActiveState'])) return true;
    // A failed unit of an earlier run stays loaded until reset; it no longer uses the clone.
    await run(SYSTEMCTL, ['reset-failed', unit]);
  }
  return false;
}

/** Result of a unit that ended with a failure; it stays loaded until reset-failed. */
async function failedResult(name) {
  const { out } = await run(
    SYSTEMCTL,
    ['show', '-p', 'LoadState', '-p', 'Result', '-p', 'ExecMainStatus', `${name}.service`],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const fields = Object.fromEntries(
    out
      .trim()
      .split('\n')
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
  if (fields['LoadState'] !== 'loaded') return { result: 'start-failed', exitStatus: null };
  await run(SYSTEMCTL, ['reset-failed', `${name}.service`]);
  return {
    result: fields['Result'] || 'unknown',
    exitStatus: Number(fields['ExecMainStatus']) || null,
  };
}

/**
 * The host's own managed settings (`managed-settings.d/*.json` in name order, then
 * `managed-settings.json`), merged; the per-run directory is mounted over that directory, so its
 * keys must be carried into the run's document. Files must be root-owned like the directory.
 */
export async function hostManaged(dir) {
  const files = [];
  try {
    const dropIns = (await readdir(join(dir, 'managed-settings.d'))).filter((n) =>
      n.endsWith('.json'),
    );
    files.push(...dropIns.sort().map((name) => join(dir, 'managed-settings.d', name)));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  files.push(join(dir, 'managed-settings.json'));
  let merged = {};
  for (const file of files) {
    let info;
    try {
      info = await stat(file);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) {
      throw new Error(`${file} must be a root-owned file not writable by others`);
    }
    const document = JSON.parse(await readFile(file, 'utf8'));
    if (typeof document !== 'object' || document === null || Array.isArray(document)) {
      throw new Error(`${file} is not a JSON object`);
    }
    merged = mergeManaged(merged, document, new Set());
  }
  return merged;
}

/**
 * Write the per-run policy directory (root-owned, world-readable, nothing secret in it): the
 * managed settings, the mount point for the skills and, in probe mode, a copy of the probe script
 * that the unit reads through its interpreter. Nothing here is executed (see systemdRunArgs).
 */
async function writePolicy(config, options, probe) {
  const dir = policyDir(config, options);
  await mkdir(config.policyRoot, { recursive: true, mode: 0o711 });
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, '.claude', 'skills'), { recursive: true, mode: 0o755 });
  await chmod(dir, 0o755);
  await writeFile(
    join(dir, 'managed-settings.json'),
    `${JSON.stringify(mergeManaged(await hostManaged(config.managedSettingsDir), managedSettings(config, options)), null, 2)}\n`,
    { mode: 0o644, flag: 'wx' },
  );
  if (probe) {
    const copy = probePath(config, options);
    await copyFile(probe, copy, constants.COPYFILE_EXCL);
    await chmod(copy, 0o644);
  }
  return dir;
}

/** Stop the unit when the runner gives up (SIGTERM through sudo) or the clone grows too big. */
function supervise(config, options, clone) {
  const name = `${unitName(options)}.service`;
  const state = { reason: null };
  const stop = (reason) => {
    state.reason ??= reason;
    void run(SYSTEMCTL, ['stop', '--no-block', name]);
  };
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'];
  for (const signal of signals) process.on(signal, () => stop('signal'));
  const timer = setInterval(() => {
    diskUsage(clone)
      .then((bytes) => {
        if (bytes > options.diskLimitBytes) stop('disk-limit');
      })
      .catch(() => stop('disk-check-failed'));
  }, config.diskCheckIntervalSec * 1000);
  return {
    state,
    /** Stop measuring; the signal handlers stay until `end`, so a late SIGTERM is absorbed. */
    stopChecks: () => clearInterval(timer),
    end: () => {
      clearInterval(timer);
      for (const signal of signals) process.removeAllListeners(signal);
    },
  };
}

/**
 * The configuration file: CONFIG_PATH, or CVX_AGENT_SANDBOX_CONFIG when root calls the helper
 * directly (tests, acceptance script); sudo always sets SUDO_UID, so the runner cannot use it.
 */
function configPath() {
  const override = process.env['CVX_AGENT_SANDBOX_CONFIG'];
  if (override === undefined || process.env['SUDO_UID'] !== undefined) return CONFIG_PATH;
  return override;
}

/**
 * Split the run's --allow-address values into those inside the configured mcpAllowedAddresses
 * (kept for IPAddressAllow=) and the rest (dropped, reported in the prepared status line).
 */
export function partitionAddresses(addresses, ranges) {
  const allowed = new BlockList();
  for (const range of ranges) {
    const [network, prefix] = range.split('/');
    const family = isIP(network) === 6 ? 'ipv6' : 'ipv4';
    allowed.addSubnet(network, Number(prefix), family);
  }
  const kept = [];
  const refused = [];
  for (const address of addresses) {
    const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
    (allowed.check(address, family) ? kept : refused).push(address);
  }
  return { kept, refused };
}

/** Validate everything about a run before anything changes on disk; returns what it needs. */
async function check(argv, probe) {
  const options = parseRunArgs(argv, { probe: probe !== null });
  const config = await loadConfig(configPath());
  assertWithinLimits(options, config.maxLimits);
  const addresses = partitionAddresses(options.allowAddresses, config.mcpAllowedAddresses);
  options.allowAddresses = addresses.kept;
  options.refusedAddresses = addresses.refused;
  applyRegistry(options, config);
  const ids = await resolveIds(config);
  const clone = clonePath(config, options);
  await assertRealDirectoryBelow(config.codeRoot, clone);
  if (options.skillsDir) {
    await assertRealDirectoryBelow(config.runnerWorkspacesRoot, options.skillsDir);
  }
  await assertRootProgram(config.execWrapper);
  for (const tool of options.tools) await assertToolProgram(config, tool.path);
  if (!(await stat(config.managedSettingsDir)).isDirectory()) {
    throw new Error(`${config.managedSettingsDir} must be a directory`);
  }
  const name = unitName(options);
  if (await unitLoaded(name)) throw new Error(`unit ${name} exists already`);
  if (await cloneInUse(clone)) throw new Error('another agent unit still works in this clone');
  return { options, config, ids, clone, name };
}

/** Exit code of the helper for a finished unit. */
function exitCode(result, exit, diskBytes, options) {
  if (result === 'disk-limit' || (diskBytes ?? 0) > options.diskLimitBytes) return EXIT.diskLimit;
  if (result === 'timeout') return EXIT.timeout;
  return exit.code ?? EXIT.internal;
}

/** Write the policy, hand the clone to the agent user and run the unit until it ends. */
async function startUnit({ config, options, ids, clone, probe, supervisor }) {
  await writePolicy(config, options, probe);
  await chownTree(clone, ids.agent.uid, ids.agent.gid);
  if (supervisor.state.reason === 'signal') throw new Error('stopped before the unit started');
  const args = systemdRunArgs(config, options, ids, {
    skillsDir: options.skillsDir,
    probe: probe !== null,
  });
  return run(SYSTEMD_RUN, args, { stdio: 'inherit' });
}

/** Prepare, run and release one unit; returns the helper's exit code. */
export async function runAgent(argv, { probe = null } = {}) {
  const { options, config, ids, clone, name } = await check(argv, probe);
  const before = await diskUsage(clone);
  status(options.statusTag, {
    event: 'prepared',
    unit: name,
    diskBytes: before,
    ...(options.refusedAddresses.length > 0 ? { refusedAddresses: options.refusedAddresses } : {}),
  });
  if (before > options.diskLimitBytes) {
    status(options.statusTag, { event: 'finished', result: 'disk-limit', diskBytes: before });
    return EXIT.diskBefore;
  }
  const supervisor = supervise(config, options, clone);
  const policy = policyDir(config, options);
  let exit;
  try {
    exit = await startUnit({ config, options, ids, clone, probe, supervisor });
  } finally {
    supervisor.stopChecks();
    await run(SYSTEMCTL, ['stop', `${name}.service`]);
    try {
      await chownTree(clone, ids.owner.uid, ids.codeGid, { share: true, budget: Infinity });
    } finally {
      await rm(policy, { recursive: true, force: true });
      supervisor.end();
    }
  }
  const failure = exit.code === 0 ? null : await failedResult(name);
  const after = await diskUsage(clone).catch(() => null);
  const result =
    supervisor.state.reason ??
    (after === null ? 'disk-check-failed' : null) ??
    (after > options.diskLimitBytes ? 'disk-limit' : null) ??
    failure?.result ??
    'success';
  status(options.statusTag, {
    event: 'finished',
    result,
    exitCode: exit.code,
    exitStatus: failure?.exitStatus ?? 0,
    diskBytes: after,
    diskLimitBytes: options.diskLimitBytes,
  });
  return exitCode(result, exit, after, options);
}

/**
 * Hand a clone back to the owner and the shared group when no agent unit works in it, e.g. after
 * the helper was killed during a run. Returns 0, or 75 while a unit still uses the clone.
 */
export async function releaseClone(argv) {
  const options = parseReleaseArgs(argv);
  const config = await loadConfig(configPath());
  const ids = await resolveIds(config);
  const clone = clonePath(config, options);
  await assertRealDirectoryBelow(config.codeRoot, clone);
  if (await cloneInUse(clone)) return EXIT.inUse;
  await chownTree(clone, ids.owner.uid, ids.codeGid, { share: true, budget: Infinity });
  return 0;
}

/** Entry point: `agent-run run ...`, or `agent-run probe <script> run ...` for root only. */
export async function main(argv) {
  let probe = null;
  let args = argv;
  if (argv[0] === 'probe') {
    if (process.getuid() !== 0 || process.env['SUDO_UID'] !== undefined) {
      throw new UsageError('probe mode is for root only, not through sudo');
    }
    probe = argv[1];
    args = argv.slice(2);
  }
  if (process.getuid() !== 0) throw new UsageError('agent-run must run as root');
  if (args[0] === 'release' && probe === null) return releaseClone(args);
  return runAgent(args, { probe });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.umask(0o022);
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(
        `agent-run: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(error instanceof UsageError ? EXIT.usage : EXIT.internal);
    });
}
