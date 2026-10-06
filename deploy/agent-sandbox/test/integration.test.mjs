// Starts real transient units through agent-run in probe mode (no claude). Runs only as root
// with CVX_SANDBOX_INTEGRATION=1 on a host with systemd-run, bubblewrap and mount (one test puts
// the policy root on a tmpfs mounted noexec, like /run on Debian).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER = join(HERE, '..', 'agent-run.mjs');
const enabled =
  process.env['CVX_SANDBOX_INTEGRATION'] === '1' &&
  process.getuid?.() === 0 &&
  existsSync('/usr/bin/systemd-run') &&
  existsSync('/usr/bin/bwrap');

const PROJECT = 'e'.repeat(24);
const TAG = 'f'.repeat(32);

const PROBE = `#!/bin/bash
echo "uid=$(id -u)"
findmnt -no OPTIONS -T "$0" | tr , '\\n' | grep -qx noexec && echo "policy-mount=noexec" || echo "policy-mount=exec"
echo "scrub=$CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"
echo "tokenlen=\${#CLAUDE_CODE_OAUTH_TOKEN}"
echo "runlen=\${#CONCLAVIX_RUN_BEARER}"
echo ok > own.txt && echo "write-own=ok"
cat ../ITG-2/secret.txt >/dev/null 2>&1 && echo "other-clone=readable" || echo "other-clone=hidden"
ls "$CVX_ROOT/repos" >/dev/null 2>&1 && echo "repos=visible" || echo "repos=hidden"
grep -qx systemd /proc/1/comm 2>/dev/null && echo "proc1=host" || echo "proc1=hidden"
echo x > /etc/cvx-probe 2>/dev/null && echo "etc=writable" || echo "etc=readonly"
bwrap --unshare-all --die-with-parent --ro-bind / / --proc /proc --dev /dev -- /bin/true && echo "bwrap=ok"
if [[ $1 == memory ]]; then head -c 600M /dev/zero | tail > /dev/null; fi
if [[ $1 == sleep ]]; then sleep 300; fi
if [[ $1 == grow ]]; then head -c 30M /dev/zero > big.bin; fi
if [[ $1 == stdin ]]; then echo "stdin-type=$(stat -L -c %F /dev/stdin)"; echo "stdin=$(base64 -w0)"; fi
exit 0
`;

describe(
  'agent-run in a real unit',
  { skip: !enabled && 'set CVX_SANDBOX_INTEGRATION=1 and run as root' },
  () => {
    let root;
    let config;
    let probe;
    let noexec;

    const writeConfig = (name, overrides) => {
      const file = join(root, name);
      writeFileSync(
        file,
        JSON.stringify({
          codeRoot: join(root, 'code'),
          runnerWorkspacesRoot: join(root, 'runner'),
          agentUser: 'nobody',
          ownerUser: 'daemon',
          codeGroup: 'users',
          execWrapper: join(root, 'libexec', 'agent-exec.sh'),
          policyRoot: join(root, 'policy'),
          managedSettingsDir: join(root, 'managed'),
          hiddenPaths: ['/srv', '/opt', join(root, 'code')],
          ...overrides,
        }),
        { mode: 0o644 },
      );
      return file;
    };

    before(() => {
      root = mkdtempSync(join(tmpdir(), 'cvx-sandbox-it-'));
      chmodSync(root, 0o755);
      for (const key of ['ITG-1', 'ITG-2']) {
        mkdirSync(join(root, 'code', 'workspaces', PROJECT, key), { recursive: true });
      }
      mkdirSync(join(root, 'code', 'repos'));
      writeFileSync(join(root, 'code', 'workspaces', PROJECT, 'ITG-2', 'secret.txt'), 'other');
      mkdirSync(join(root, 'runner'));
      mkdirSync(join(root, 'managed'));
      mkdirSync(join(root, 'policy'));
      probe = join(root, 'probe.sh');
      writeFileSync(probe, PROBE.replace('$CVX_ROOT', join(root, 'code')), { mode: 0o755 });
      // The wrapper must be root-owned with root-owned parents, so the checkout is not used.
      mkdirSync(join(root, 'libexec'), { mode: 0o755 });
      copyFileSync(join(HERE, '..', 'agent-exec.sh'), join(root, 'libexec', 'agent-exec.sh'));
      chmodSync(join(root, 'libexec', 'agent-exec.sh'), 0o755);
      config = writeConfig('config.json', {});
      noexec = join(root, 'noexec');
      mkdirSync(noexec);
      const mounted = spawnSync('/usr/bin/mount', [
        '-t',
        'tmpfs',
        '-o',
        'noexec,nosuid,nodev,mode=0711,size=8m',
        'cvx-sandbox-it',
        noexec,
      ]);
      assert.equal(mounted.status, 0, String(mounted.stderr));
    });
    after(() => {
      if (noexec && spawnSync('/usr/bin/umount', [noexec]).status !== 0) {
        spawnSync('/usr/bin/umount', ['--lazy', noexec]);
      }
      rmSync(root, { recursive: true, force: true });
    });

    const b64 = (value) => Buffer.from(value).toString('base64');
    const ENV_INPUT = `CLAUDE_CODE_OAUTH_TOKEN=${b64('not-a-real-token')}\nCONCLAVIX_RUN_BEARER=${b64('cvx_run_synthetic')}\n\n`;

    const runProbe = (runId, mode, extra = [], configFile = config, stdin = ENV_INPUT) =>
      spawnSync(
        process.execPath,
        [
          HELPER,
          'probe',
          probe,
          'run',
          '--run-id',
          runId,
          '--project',
          PROJECT,
          '--issue',
          'ITG-1',
          '--status-tag',
          TAG,
          ...extra,
          '--',
          mode,
        ],
        {
          ...(typeof stdin === 'string' ? { input: stdin } : { stdio: [stdin, 'pipe', 'pipe'] }),
          encoding: 'utf8',
          env: { PATH: '/usr/bin:/bin', CVX_AGENT_SANDBOX_CONFIG: configFile },
          timeout: 120_000,
        },
      );

    it('sees only its clone, cannot write the system and keeps bubblewrap working', () => {
      const result = runProbe('1'.repeat(24), 'basic');
      assert.equal(result.status, 0, result.stderr);
      for (const line of [
        'uid=65534',
        'scrub=1',
        'tokenlen=16',
        'runlen=17',
        'write-own=ok',
        'other-clone=hidden',
        'repos=hidden',
        'proc1=hidden',
        'etc=readonly',
        'bwrap=ok',
        'policy-mount=noexec',
      ]) {
        assert.match(result.stdout, new RegExp(`^${line}$`, 'm'), line);
      }
      assert.match(result.stderr, /"result":"success"/);
      const own = statSync(join(root, 'code', 'workspaces', PROJECT, 'ITG-1', 'own.txt'));
      assert.equal(own.uid, 1);
      assert.equal(own.mode & 0o777, 0o660);
    });

    // A FIFO cannot be read again from offset 0 or reopened onto the environment lines, whichever
    // way the program reads its stdin.
    it('hands the program only the input after the environment, as a FIFO', () => {
      const prompt = '{"type":"user"}\n';
      const expected = `stdin=${Buffer.from(prompt).toString('base64')}`;
      const check = (result) => {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /^stdin-type=fifo$/m);
        assert.match(result.stdout, new RegExp(`^${expected}$`, 'm'));
      };
      check(runProbe('7'.repeat(24), 'stdin', [], config, ENV_INPUT + prompt));
      const file = join(root, 'stdin-input');
      writeFileSync(file, ENV_INPUT + prompt, { mode: 0o600 });
      const fd = openSync(file, 'r');
      try {
        check(runProbe('8'.repeat(24), 'stdin', [], config, fd));
      } finally {
        closeSync(fd);
      }
    });

    it('starts units when the policy root is mounted noexec, like /run on Debian', () => {
      const policyRoot = join(noexec, 'policy');
      mkdirSync(policyRoot, { mode: 0o711 });
      const findmnt = spawnSync('/usr/bin/findmnt', ['-no', 'OPTIONS', '-T', policyRoot], {
        encoding: 'utf8',
      });
      assert.match(findmnt.stdout, /(^|,)noexec(,|$)/);
      const result = runProbe(
        '5'.repeat(24),
        'basic',
        [],
        writeConfig('noexec.json', { policyRoot }),
      );
      assert.equal(result.status, 0, result.stderr);
      for (const line of [
        'uid=65534',
        'tokenlen=16',
        'write-own=ok',
        'bwrap=ok',
        'policy-mount=noexec',
      ]) {
        assert.match(result.stdout, new RegExp(`^${line}$`, 'm'), line);
      }
      assert.match(result.stderr, /"result":"success"/);
      assert.deepEqual(readdirSync(policyRoot), []);
    });

    it('refuses a wrapper on a noexec filesystem before anything starts', () => {
      const wrapper = join(noexec, 'agent-exec.sh');
      copyFileSync(join(root, 'libexec', 'agent-exec.sh'), wrapper);
      chmodSync(wrapper, 0o755);
      const result = runProbe(
        '6'.repeat(24),
        'basic',
        [],
        writeConfig('bad.json', { execWrapper: wrapper }),
      );
      assert.equal(result.status, 70, result.stderr);
      assert.match(result.stderr, /mounted without noexec/);
      assert.doesNotMatch(result.stderr, /"event":"prepared"/);
    });

    it('stops a unit that exceeds its memory limit', () => {
      const result = runProbe('2'.repeat(24), 'memory', ['--memory-max', '256M']);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /"result":"oom-kill"/);
    });

    it('stops a unit that exceeds its time limit', () => {
      const result = runProbe('3'.repeat(24), 'sleep', ['--runtime-max-sec', '60']);
      assert.equal(result.status, 124, result.stdout + result.stderr);
      assert.match(result.stderr, /"result":"timeout"/);
    });

    it('reports a clone over the disk limit at the end of the run', () => {
      const result = runProbe('4'.repeat(24), 'grow', ['--disk-limit-mb', '20']);
      assert.equal(result.status, 125, result.stderr);
      assert.match(result.stderr, /"event":"finished","result":"disk-limit"/);
      rmSync(join(root, 'code', 'workspaces', PROJECT, 'ITG-1', 'big.bin'), { force: true });
    });

    it('releases a clone whose only unit failed earlier and is still loaded', () => {
      const unit = `cvx-agent-${'9'.repeat(24)}`;
      const clone = join(root, 'code', 'workspaces', PROJECT, 'ITG-1');
      spawnSync('/usr/bin/systemd-run', [
        `--unit=${unit}`,
        '--wait',
        '--quiet',
        '-p',
        `WorkingDirectory=${clone}`,
        '/bin/false',
      ]);
      const result = spawnSync(
        process.execPath,
        [HELPER, 'release', '--project', PROJECT, '--issue', 'ITG-1'],
        {
          encoding: 'utf8',
          env: { PATH: '/usr/bin:/bin', CVX_AGENT_SANDBOX_CONFIG: config },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const state = spawnSync('/usr/bin/systemctl', ['show', '-p', 'LoadState', '--value', unit], {
        encoding: 'utf8',
      });
      assert.equal(state.stdout.trim(), 'not-found');
    });
  },
);
