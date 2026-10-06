import { join } from 'node:path';

/** Writable inside the unit and, through allowWrite, inside the Bash sandbox: package caches. */
export const CACHE_DIR = '/tmp/cvx-cache';
/** HOME of claude inside the unit, on the unit's private /tmp. */
export const RUN_HOME = '/tmp/cvx-home';

/**
 * Variables claude needs and sandboxed commands must never see. The run token's name avoids
 * credential patterns on purpose (claude would not expand it into the MCP header under the env
 * scrub), so the scrub does not cover it and this deny entry is what hides it from Bash.
 */
export const SECRET_ENV = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CONCLAVIX_RUN_BEARER',
];

/** The clone of an issue below the code root. */
export const clonePath = (config, options) =>
  join(config.codeRoot, 'workspaces', options.projectId, options.issueKey);

export const unitName = (options) => `cvx-agent-${options.runId}`;

export const policyDir = (config, options) => join(config.policyRoot, options.runId);

/** The probe script of a root-only probe run, copied into the policy directory (not executable). */
export const probePath = (config, options) => join(policyDir(config, options), 'probe.sh');

/**
 * Interpreter of the probe script. Nothing is executed from the policy directory: it lives on /run,
 * which Debian mounts noexec, and the unit mounts it noexec in any case.
 */
export const PROBE_SHELL = '/bin/bash';

/**
 * The managed settings of one run, mounted at /etc/claude-code inside the unit: permission rules,
 * hooks and network domains come from this document only (allowManaged* locks), Bash runs in the
 * sandbox without an unsandboxed fallback, and the file tools stay inside the clone.
 */
export function managedSettings(config, options) {
  const clone = clonePath(config, options);
  const domains = [...new Set([...config.allowedDomains, ...options.extraDomains])].sort();
  return {
    allowManagedPermissionRulesOnly: true,
    allowManagedHooksOnly: true,
    disableAllHooks: true,
    permissions: {
      defaultMode: 'dontAsk',
      disableBypassPermissionsMode: 'disable',
      blockReadsOutsideWorkingDirectories: true,
      allow: ['Bash', `Edit(/${clone}/**)`, 'Skill', 'mcp__conclavix'],
      deny: [
        'Read(//proc/**)',
        'Read(//sys/**)',
        'Read(//run/**)',
        'Read(//etc/conclavix/**)',
        `Edit(/${clone}/.git/**)`,
        'WebFetch',
        'WebSearch',
        'Agent',
        'Task',
        'NotebookEdit',
      ],
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      excludedCommands: [],
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false,
      network: {
        allowManagedDomainsOnly: true,
        strictAllowlist: true,
        allowLocalBinding: false,
        allowAllUnixSockets: false,
        allowedDomains: domains,
      },
      filesystem: { allowWrite: [CACHE_DIR] },
      credentials: { envVars: SECRET_ENV.map((name) => ({ name, mode: 'deny' })) },
    },
  };
}

const memory = (bytes) => `${Math.floor(bytes / (1024 * 1024))}M`;

/**
 * systemd properties of the transient unit, one `-p` argument each. Properties under which
 * bubblewrap cannot start are not set; docs/coding-agents.md lists them. Every value here is
 * readable through `systemctl show`, so none of them is a secret.
 */
export function unitProperties(config, options, ids, { skillsDir } = {}) {
  const clone = clonePath(config, options);
  const policy = policyDir(config, options);
  return [
    `User=${ids.agent.uid}`,
    `Group=${ids.agent.gid}`,
    'SupplementaryGroups=',
    `WorkingDirectory=${clone}`,
    'NoNewPrivileges=yes',
    'ProtectSystem=strict',
    'ProtectHome=tmpfs',
    'PrivateTmp=yes',
    'PrivateIPC=yes',
    'PrivateDevices=yes',
    'PrivatePIDs=yes',
    'ProtectProc=invisible',
    'ProtectClock=yes',
    'ProtectKernelModules=yes',
    'ProtectControlGroups=yes',
    'LockPersonality=yes',
    'RestrictRealtime=yes',
    'SystemCallArchitectures=native',
    'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK',
    'CapabilityBoundingSet=',
    'AmbientCapabilities=',
    'KeyringMode=private',
    'UMask=0077',
    ...config.hiddenPaths.map((path) => `TemporaryFileSystem=${path}:ro`),
    ...config.inaccessiblePaths.map((path) => `InaccessiblePaths=-${path}`),
    `BindPaths=${clone}`,
    `BindReadOnlyPaths=${policy}`,
    // Nothing in the policy directory is a program; the wrapper is started from its root-owned
    // install path, bound read-only so hidden or private paths cannot shadow it.
    `NoExecPaths=${policy}`,
    `BindReadOnlyPaths=${config.execWrapper}`,
    `BindReadOnlyPaths=${policy}:${config.managedSettingsDir}`,
    ...(skillsDir
      ? [`BindReadOnlyPaths=${skillsDir}:${config.managedSettingsDir}/.claude/skills`]
      : []),
    `IPAddressDeny=${config.deniedAddresses.join(' ')}`,
    `MemoryMax=${memory(options.memoryMaxBytes)}`,
    'MemorySwapMax=0',
    `CPUQuota=${options.cpuQuotaPercent}%`,
    `TasksMax=${options.tasksMax}`,
    `RuntimeMaxSec=${options.runtimeMaxSec}`,
    'KillMode=control-group',
    'TimeoutStopSec=15s',
    'OOMPolicy=kill',
  ];
}

/**
 * Arguments of systemd-run: a transient service that gets the caller's stdio and is waited for.
 * The unit starts the installed wrapper, which execs claude, or in probe mode the probe script
 * through PROBE_SHELL. The service manager would expand `${NAME}` and `$NAME` in the command line
 * from the unit's environment, which holds none of the run's variables: the MCP config's
 * `Bearer ${CONCLAVIX_RUN_BEARER}` would reach claude as `Bearer `. The arguments therefore pass
 * unexpanded, and claude expands the reference itself from the environment the wrapper sets.
 */
export function systemdRunArgs(config, options, ids, extra = {}) {
  const program = extra.probe ? [PROBE_SHELL, probePath(config, options)] : [config.claudeBin];
  return [
    `--unit=${unitName(options)}`,
    '--service-type=exec',
    '--expand-environment=no',
    '--quiet',
    '--pipe',
    '--wait',
    ...unitProperties(config, options, ids, extra).flatMap((property) => ['-p', property]),
    '--',
    config.execWrapper,
    ...program,
    ...options.claudeArgs,
  ];
}

/** Paths where only the run's own list counts; host lists there could widen the sandbox. */
const RUN_ONLY_LISTS = new Set([
  'permissions.allow',
  'permissions.additionalDirectories',
  'sandbox.excludedCommands',
  'sandbox.network.allowedDomains',
  'sandbox.filesystem.allowWrite',
  'sandbox.filesystem.allowRead',
]);

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Merge the host's managed settings (`base`) under the run's policy (`run`): objects merge key by
 * key, the run's scalar values win, lists are combined except those in RUN_ONLY_LISTS, which come
 * from the run alone.
 */
export function mergeManaged(base, run, runOnly = RUN_ONLY_LISTS, path = '') {
  const merged = {};
  for (const [key, value] of Object.entries(base)) {
    const keyPath = path === '' ? key : `${path}.${key}`;
    if (!(Array.isArray(value) && runOnly.has(keyPath))) merged[key] = value;
  }
  for (const [key, value] of Object.entries(run)) {
    merged[key] = mergeValue(merged[key], value, runOnly, path === '' ? key : `${path}.${key}`);
  }
  return merged;
}

function mergeValue(previous, value, runOnly, keyPath) {
  if (isObject(value) && isObject(previous)) return mergeManaged(previous, value, runOnly, keyPath);
  if (!Array.isArray(value) || !Array.isArray(previous) || runOnly.has(keyPath)) return value;
  const seen = new Set();
  return [...previous, ...value].filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
