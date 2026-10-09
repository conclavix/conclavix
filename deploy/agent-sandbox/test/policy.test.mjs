import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parseRunArgs } from '../args.mjs';
import { mergeConfig } from '../config.mjs';
import {
  managedSettings,
  mergeManaged,
  SECRET_ENV,
  systemdRunArgs,
  unitProperties,
} from '../policy.mjs';

const config = mergeConfig({});
const options = parseRunArgs([
  'run',
  '--run-id',
  'a'.repeat(24),
  '--project',
  'b'.repeat(24),
  '--issue',
  'CVX-3',
  '--status-tag',
  'c'.repeat(32),
  '--allow-domain',
  'registry.yarnpkg.com',
  '--',
  '-p',
  '--strict-mcp-config',
  '--permission-mode',
  'dontAsk',
  '--setting-sources',
  'user',
]);
const ids = { agent: { uid: 999, gid: 987 }, owner: { uid: 995, gid: 986 }, codeGid: 990 };
const clone = `/srv/conclavix/code/workspaces/${'b'.repeat(24)}/CVX-3`;

describe('managedSettings', () => {
  const settings = managedSettings(config, options);

  it('locks the sandbox on without an unsandboxed fallback', () => {
    assert.equal(settings.sandbox.enabled, true);
    assert.equal(settings.sandbox.failIfUnavailable, true);
    assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
    assert.deepEqual(settings.sandbox.excludedCommands, []);
    assert.equal(settings.sandbox.enableWeakerNestedSandbox, false);
    assert.equal(settings.sandbox.network.allowManagedDomainsOnly, true);
    assert.equal(settings.sandbox.network.allowLocalBinding, false);
    assert.equal(settings.sandbox.network.allowAllUnixSockets, false);
    assert.equal(settings.sandbox.filesystem.allowManagedReadPathsOnly, undefined);
  });

  it('allows the registries and the extra domains only', () => {
    assert.deepEqual(settings.sandbox.network.allowedDomains, [
      'files.pythonhosted.org',
      'pypi.org',
      'registry.npmjs.org',
      'registry.yarnpkg.com',
    ]);
  });

  it('takes permission rules and hooks from the managed settings only', () => {
    assert.equal(settings.allowManagedPermissionRulesOnly, true);
    assert.equal(settings.allowManagedHooksOnly, true);
    assert.equal(settings.permissions.blockReadsOutsideWorkingDirectories, true);
    assert.equal(settings.permissions.disableBypassPermissionsMode, 'disable');
    // The env scrub forces the permission mode to default, so these rules alone carry the tools.
    assert.deepEqual(settings.permissions.allow, [
      'Bash',
      `Edit(/${clone}/**)`,
      'Skill',
      'mcp__conclavix',
    ]);
    assert.ok(settings.permissions.deny.includes('Read(//proc/**)'));
    assert.ok(settings.permissions.deny.includes(`Edit(/${clone}/.git/**)`));
  });

  it('hides every secret variable from sandboxed commands', () => {
    const names = settings.sandbox.credentials.envVars.map((entry) => entry.name);
    assert.deepEqual(names, SECRET_ENV);
    assert.ok(settings.sandbox.credentials.envVars.every((entry) => entry.mode === 'deny'));
  });

  it('hides exactly the secrets the exec wrapper accepts, the run token included', () => {
    const script = readFileSync(new URL('../agent-exec.sh', import.meta.url), 'utf8');
    const allowed = new RegExp(/^readonly allowed='([^']+)'$/m.exec(script)[1]);
    assert.deepEqual(
      SECRET_ENV.filter((name) => !allowed.test(name)),
      [],
    );
    assert.ok(SECRET_ENV.includes('CONCLAVIX_RUN_BEARER'));
    // A credential-like name would be expanded to an empty string in the MCP header.
    assert.ok(!allowed.test('CONCLAVIX_RUN_TOKEN'));
  });
});

describe('mergeManaged', () => {
  it('keeps host keys and lets the run win on scalars and allow lists', () => {
    const host = {
      env: { DISABLE_AUTOUPDATER: '1' },
      permissions: { allow: ['Bash(*)'], deny: ['Read(//data/**)'], additionalDirectories: ['/'] },
      sandbox: { enabled: false, network: { allowedDomains: ['evil.example'] } },
    };
    const merged = mergeManaged(host, managedSettings(config, options));
    assert.deepEqual(merged.env, { DISABLE_AUTOUPDATER: '1' });
    assert.equal(merged.sandbox.enabled, true);
    assert.ok(!merged.permissions.allow.includes('Bash(*)'));
    assert.equal(merged.permissions.additionalDirectories, undefined);
    assert.ok(merged.permissions.deny.includes('Read(//data/**)'));
    assert.ok(!merged.sandbox.network.allowedDomains.includes('evil.example'));
  });
});

describe('unitProperties', () => {
  const properties = unitProperties(config, options, ids, {
    skillsDir: '/srv/conclavix/workspaces/x/.claude/skills',
  });

  it('runs as the agent user with no capabilities and no new privileges', () => {
    for (const expected of [
      'User=999',
      'Group=987',
      'NoNewPrivileges=yes',
      'CapabilityBoundingSet=',
      'ProtectSystem=strict',
      'ProtectHome=tmpfs',
      'PrivateTmp=yes',
      'ProtectProc=invisible',
      'PrivatePIDs=yes',
    ]) {
      assert.ok(properties.includes(expected), expected);
    }
  });

  it('hides /srv and binds only the clone, the policy and the skills', () => {
    assert.ok(properties.includes('TemporaryFileSystem=/srv:ro'));
    assert.ok(properties.includes(`BindPaths=${clone}`));
    assert.equal(properties.filter((p) => p.startsWith('BindPaths=')).length, 1);
    assert.ok(
      properties.includes(
        `BindReadOnlyPaths=/run/conclavix-agent/${'a'.repeat(24)}:/etc/claude-code`,
      ),
    );
    assert.ok(properties.some((p) => p.endsWith(':/etc/claude-code/.claude/skills')));
    assert.ok(properties.includes('InaccessiblePaths=-/etc/conclavix'));
  });

  it('executes nothing from the policy directory and binds the installed wrapper', () => {
    assert.ok(properties.includes(`NoExecPaths=/run/conclavix-agent/${'a'.repeat(24)}`));
    assert.ok(properties.includes('BindReadOnlyPaths=/usr/local/libexec/conclavix/agent-exec.sh'));
  });

  it('sets the resource limits', () => {
    for (const expected of [
      'MemoryMax=4096M',
      'MemorySwapMax=0',
      'CPUQuota=200%',
      'TasksMax=512',
      'RuntimeMaxSec=1800',
      'KillMode=control-group',
    ]) {
      assert.ok(properties.includes(expected), expected);
    }
  });

  it('leaves out the properties bubblewrap cannot run under', () => {
    for (const name of [
      'ProtectKernelTunables',
      'ProtectKernelLogs',
      'RestrictSUIDSGID',
      'ProcSubset',
      'RestrictNamespaces',
      'ProtectHostname',
      'SystemCallFilter',
      'PrivateUsers',
    ]) {
      assert.ok(!properties.some((p) => p.startsWith(`${name}=`)), name);
    }
  });

  it('puts no environment variable into the unit without sandbox tools', () => {
    const args = systemdRunArgs(config, options, ids);
    assert.ok(
      !args.some(
        (arg) => arg.startsWith('--setenv') || arg === '-E' || arg.startsWith('Environment'),
      ),
    );
    assert.equal(args.at(args.indexOf('--') + 1), '/usr/local/libexec/conclavix/agent-exec.sh');
    assert.equal(args.at(args.indexOf('--') + 2), '/usr/bin/claude');
    assert.equal(args.at(args.indexOf('--') + 3), '-p');
  });

  it('passes the claude flags without environment expansion by the service manager', () => {
    const args = systemdRunArgs(config, options, ids);
    const separator = args.indexOf('--');
    assert.ok(args.indexOf('--expand-environment=no') > -1);
    assert.ok(args.indexOf('--expand-environment=no') < separator);
  });

  it('starts the probe through its interpreter, never as a program from the policy directory', () => {
    const args = systemdRunArgs(config, options, ids, { probe: true });
    const command = args.slice(args.indexOf('--') + 1);
    assert.deepEqual(command.slice(0, 3), [
      '/usr/local/libexec/conclavix/agent-exec.sh',
      '/bin/bash',
      `/run/conclavix-agent/${'a'.repeat(24)}/probe.sh`,
    ]);
    assert.ok(!command.some((arg) => arg.endsWith('/agent-exec.sh') && arg.startsWith('/run/')));
  });
});

describe('sandbox tools', () => {
  const withTools = parseRunArgs([
    'run',
    '--run-id',
    'a'.repeat(24),
    '--project',
    'b'.repeat(24),
    '--issue',
    'CVX-3',
    '--status-tag',
    'c'.repeat(32),
    '--tool',
    'MONGOD_BIN=/usr/local/lib/test-tools/mongodb/bin/mongod',
    '--tool',
    'CHROME_BIN=/usr/local/lib/test-tools/chrome/chrome-headless-shell',
    '--',
    '-p',
    '--strict-mcp-config',
    '--permission-mode',
    'dontAsk',
    '--setting-sources',
    'user',
  ]);
  const properties = unitProperties(config, withTools, ids);

  it('sets one Environment= property per tool, holding only its path', () => {
    assert.deepEqual(
      properties.filter((p) => p.startsWith('Environment')),
      [
        'Environment=MONGOD_BIN=/usr/local/lib/test-tools/mongodb/bin/mongod',
        'Environment=CHROME_BIN=/usr/local/lib/test-tools/chrome/chrome-headless-shell',
      ],
    );
  });

  it('adds no mount for a tool', () => {
    assert.ok(!properties.some((p) => /Paths=.*test-tools/.test(p)));
  });
});
