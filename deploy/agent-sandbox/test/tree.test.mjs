import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { assertRootProgram, loadConfig, mergeConfig, resolveIds } from '../config.mjs';
import {
  assertRealDirectoryBelow,
  chownTree,
  diskUsage,
  isBelow,
  sharedMode,
  TreeError,
} from '../tree.mjs';

const isRoot = process.getuid?.() === 0;

describe('paths', () => {
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'cvx-tree-'));
    mkdirSync(join(root, 'code', 'workspaces', 'p', 'K-1'), { recursive: true });
    mkdirSync(join(root, 'elsewhere'));
    symlinkSync(join(root, 'elsewhere'), join(root, 'code', 'workspaces', 'p', 'K-2'));
    symlinkSync(join(root, 'code', 'workspaces'), join(root, 'code', 'alias'));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('accepts a real directory below the root', async () => {
    const info = await assertRealDirectoryBelow(
      join(root, 'code'),
      join(root, 'code', 'workspaces', 'p', 'K-1'),
    );
    assert.ok(info.isDirectory());
  });

  it('refuses a symlinked clone, a symlinked parent, the root itself and paths outside it', async () => {
    const code = join(root, 'code');
    for (const path of [
      join(code, 'workspaces', 'p', 'K-2'),
      join(code, 'alias', 'p', 'K-1'),
      code,
      join(root, 'elsewhere'),
      join(code, 'workspaces', 'p', 'missing'),
    ]) {
      await assert.rejects(
        assertRealDirectoryBelow(code, path),
        (error) => error instanceof TreeError || error.code === 'ENOENT',
        path,
      );
    }
    assert.equal(isBelow('/srv/a', '/srv/a/../b'), false);
    assert.equal(isBelow('/srv/a', '/srv/ab'), false);
  });
});

describe('modes', () => {
  it('shares directories as 2770 and files without setuid bits', () => {
    assert.equal(sharedMode(0o4755, false), 0o770);
    assert.equal(sharedMode(0o600, false), 0o660);
    assert.equal(sharedMode(0o000, false), 0o660);
    assert.equal(sharedMode(0o700, true), 0o2770);
  });
});

describe('chownTree and diskUsage', { skip: !isRoot && 'needs root' }, () => {
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'cvx-chown-'));
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', 'file'), 'x'.repeat(10000));
    writeFileSync(join(root, 'run.sh'), '#!/bin/sh\n');
    chmodSync(join(root, 'run.sh'), 0o4755);
    writeFileSync(join(root, 'outside'), 'keep');
    symlinkSync('/etc/passwd', join(root, 'a', 'link'));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('changes owners without following symlinks and shares modes', async () => {
    const entries = await chownTree(root, 65534, 65534, { share: true });
    assert.ok(entries >= 6);
    assert.equal(statSync(join(root, 'a', 'b', 'file')).uid, 65534);
    assert.equal(lstatSync(join(root, 'a', 'link')).uid, 65534);
    assert.equal(statSync('/etc/passwd').uid, 0);
    assert.equal(statSync(join(root, 'run.sh')).mode & 0o7777, 0o770);
    assert.equal(statSync(join(root, 'a')).mode & 0o7777, 0o2770);
    await chownTree(root, 0, 0);
    assert.equal(statSync(join(root, 'a', 'b', 'file')).uid, 0);
  });

  it('never descends through a symlinked directory', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'cvx-outside-'));
    try {
      writeFileSync(join(outside, 'secret'), 'x');
      symlinkSync(outside, join(root, 'a', 'out'));
      await chownTree(root, 65534, 65534, { share: true });
      assert.equal(statSync(join(outside, 'secret')).uid, 0);
      assert.equal(statSync(outside).uid, 0);
      assert.equal(lstatSync(join(root, 'a', 'out')).uid, 65534);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('counts allocated bytes', async () => {
    assert.ok((await diskUsage(root)) >= 10000);
  });
});

describe('configuration', () => {
  it('merges overrides and rejects unknown or unsafe values', () => {
    assert.equal(mergeConfig({ agentUser: 'agent' }).agentUser, 'agent');
    assert.throws(() => mergeConfig({ shell: '/bin/sh' }), /unknown/);
    assert.throws(() => mergeConfig({ codeRoot: 'relative' }), /invalid/);
    assert.throws(() => mergeConfig({ codeRoot: '/' }), /invalid/);
    assert.throws(() => mergeConfig({ allowedDomains: ['http://x'] }), /invalid/);
    assert.throws(() => mergeConfig({ maxLimits: { tasksMax: -1 } }), /invalid/);
    assert.equal(mergeConfig({ maxLimits: { tasksMax: 10 } }).maxLimits.runtimeMaxSec, 14400);
  });

  it(
    'refuses a configuration file others can write',
    { skip: !isRoot && 'needs root' },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cvx-config-'));
      try {
        chmodSync(dir, 0o755);
        const file = join(dir, 'agent-sandbox.json');
        writeFileSync(file, '{}', { mode: 0o666 });
        chmodSync(file, 0o666);
        await assert.rejects(loadConfig(file), /not writable/);
        chmodSync(file, 0o644);
        assert.equal((await loadConfig(file)).agentUser, 'cvx-agent');
        assert.equal((await loadConfig(join(dir, 'missing.json'))).codeRoot, '/srv/conclavix/code');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('refuses a wrapper reached through a symlink', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cvx-wrapper-'));
    try {
      writeFileSync(join(dir, 'agent-exec.sh'), '#!/bin/sh\n', { mode: 0o755 });
      symlinkSync(join(dir, 'agent-exec.sh'), join(dir, 'link.sh'));
      await assert.rejects(assertRootProgram(join(dir, 'link.sh')), /symlink/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    'accepts only a root-owned wrapper that nobody else can change and that may run',
    { skip: !isRoot && 'needs root' },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cvx-wrapper-'));
      try {
        chmodSync(dir, 0o755);
        const file = join(dir, 'agent-exec.sh');
        writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
        chmodSync(file, 0o755);
        await assertRootProgram(file);
        chmodSync(file, 0o775);
        await assert.rejects(assertRootProgram(file), /not writable/);
        chmodSync(file, 0o644);
        await assert.rejects(assertRootProgram(file), /executable/);
        chmodSync(file, 0o750);
        await assert.rejects(assertRootProgram(file), /executable by others/);
        chmodSync(file, 0o755);
        chmodSync(dir, 0o777);
        await assert.rejects(assertRootProgram(file), /not writable/);
        chmodSync(dir, 0o1777);
        await assertRootProgram(file);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('resolves ids and refuses an agent in the code group or root ids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cvx-ids-'));
    try {
      const passwd = join(dir, 'passwd');
      const group = join(dir, 'group');
      writeFileSync(
        passwd,
        'root:x:0:0::/root:/bin/sh\ncvx-agent:x:999:987::/home/a:/bin/false\ncvx-runner:x:995:986::/:/bin/false\n',
      );
      writeFileSync(group, 'cvx-code:x:990:cvx-runner\n');
      const config = mergeConfig({});
      assert.deepEqual(await resolveIds(config, { passwd, group }), {
        agent: { uid: 999, gid: 987 },
        owner: { uid: 995, gid: 986 },
        codeGid: 990,
      });
      writeFileSync(group, 'cvx-code:x:990:cvx-runner,cvx-agent\n');
      await assert.rejects(resolveIds(config, { passwd, group }), /code group/);
      await assert.rejects(
        resolveIds(mergeConfig({ ownerUser: 'root' }), { passwd, group }),
        /root/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('diskUsage while the tree changes', () => {
  it('skips entries that disappear during the walk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cvx-du-'));
    try {
      for (let i = 0; i < 200; i += 1) {
        mkdirSync(join(root, `d${i}`));
        writeFileSync(join(root, `d${i}`, 'f'), 'x'.repeat(100));
      }
      let stop = false;
      const churn = (async () => {
        let n = 0;
        while (!stop) {
          rmSync(join(root, `d${n % 200}`), { recursive: true, force: true });
          mkdirSync(join(root, `d${n % 200}`), { recursive: true });
          n += 1;
          await new Promise((resolve) => setImmediate(resolve));
        }
      })();
      for (let i = 0; i < 20; i += 1) assert.ok((await diskUsage(root)) >= 0);
      stop = true;
      await churn;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
