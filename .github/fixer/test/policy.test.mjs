import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../github.mjs';
import {
  addedLines,
  checkChanges,
  collectDiff,
  globToRegExp,
  matchesAny,
  parseNameStatus,
  parseNumstat,
} from '../policy.mjs';

const config = loadConfig();

function diff({ nameStatus = '', numstat = '', patch = '' }) {
  return { nameStatus, numstat, patch };
}

const finding = (file) => ({ id: 'F1', file });

test('globs: star stays in one segment, double star spans directories', () => {
  assert.equal(globToRegExp('*.ts').test('a.ts'), true);
  assert.equal(globToRegExp('*.ts').test('src/a.ts'), false);
  assert.equal(globToRegExp('**/test/**').test('apps/api/test/a.test.ts'), true);
  assert.equal(globToRegExp('**/test/**').test('test/a.ts'), true);
  assert.equal(globToRegExp('.github/**').test('.github/workflows/fix.yml'), true);
  assert.equal(matchesAny('apps/api/.env.local', config.forbidden_paths), true);
  assert.equal(matchesAny('apps/api/src/env.ts', config.forbidden_paths), false);
  assert.equal(matchesAny('apps/web/package.json', config.guarded_paths), true);
});

test('parsers read name-status, numstat and added lines', () => {
  assert.deepEqual(parseNameStatus('M\ta.ts\nR100\told.ts\tnew.ts\n'), [
    { status: 'M', path: 'a.ts' },
    { status: 'R', path: 'new.ts', from: 'old.ts' },
  ]);
  assert.deepEqual(parseNumstat('3\t1\ta.ts\n-\t-\timg.png\n'), [
    { path: 'a.ts', added: 3, deleted: 1, binary: false },
    { path: 'img.png', added: 0, deleted: 0, binary: true },
  ]);
  const patch = '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n--- a/gone.ts\n+++ /dev/null\n';
  assert.deepEqual(addedLines(patch), [{ path: 'a.ts', text: 'new' }]);
});

test('a small source fix with a test passes', () => {
  const result = checkChanges(
    diff({
      nameStatus: 'M\tapps/api/src/a.ts\nA\tapps/api/test/a.test.ts\n',
      numstat: '5\t2\tapps/api/src/a.ts\n300\t0\tapps/api/test/a.test.ts\n',
      patch: '+++ b/apps/api/src/a.ts\n+const x = 1;\n',
    }),
    [finding('apps/api/src/a.ts')],
    config,
  );
  assert.deepEqual(result.violations, []);
  assert.equal(result.lines, 7);
});

test('forbidden paths are refused even when a finding names them', () => {
  const result = checkChanges(
    diff({
      nameStatus: 'M\tpnpm-workspace.yaml\nM\tpnpm-lock.yaml\n',
      numstat: '1\t1\tpnpm-workspace.yaml\n',
    }),
    [finding('pnpm-workspace.yaml')],
    config,
  );
  assert.equal(result.violations.length, 2);
  assert.match(result.violations[0], /never made by the fixer/);
});

test('guarded paths need a finding about that exact file', () => {
  const change = diff({
    nameStatus: 'M\t.github/workflows/ci.yml\n',
    numstat: '1\t1\t.github/workflows/ci.yml\n',
  });
  assert.match(
    checkChanges(change, [finding('apps/api/src/a.ts')], config).violations[0],
    /guarded path/,
  );
  assert.deepEqual(
    checkChanges(change, [finding('.github/workflows/ci.yml')], config).violations,
    [],
  );
});

test('deleted or renamed tests, weakening comments, binaries and size are refused', () => {
  const del = checkChanges(diff({ nameStatus: 'D\tapps/api/test/a.test.ts\n' }), [], config);
  assert.match(del.violations[0], /test file was deleted/);
  const ren = checkChanges(
    diff({ nameStatus: 'R090\tapps/api/test/a.test.ts\tapps/api/a.ts\n' }),
    [],
    config,
  );
  assert.match(ren.violations[0], /test file/);
  for (const line of [
    '// eslint-disable-next-line',
    '// @ts-ignore',
    "it.skip('x', () => {})",
    "test.only('x')",
    "xit('x')",
  ]) {
    const result = checkChanges(diff({ patch: `+++ b/apps/api/src/a.ts\n+${line}\n` }), [], config);
    assert.equal(result.violations.length, 1, line);
  }
  const bin = checkChanges(diff({ numstat: '-\t-\tapps/web/a.png\n' }), [], config);
  assert.match(bin.violations[0], /binary/);
  const big = checkChanges(
    diff({ numstat: `${config.max_fix_lines}\t1\tapps/api/src/a.ts\n` }),
    [],
    config,
  );
  assert.match(big.violations[0], /changed non-test lines/);
});

test('collectDiff sees staged changes and commit ranges in a real repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fixer-policy-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/a.ts'), 'one\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(dir, 'src/a.ts'), 'one\n// @ts-ignore\n');
    git('add', '-A');
    const staged = checkChanges(collectDiff(base, null, dir), [], config);
    assert.equal(staged.lines, 1);
    assert.equal(staged.violations.length, 1);
    git('commit', '-qm', 'change');
    const range = checkChanges(collectDiff(base, git('rev-parse', 'HEAD'), dir), [], config);
    assert.deepEqual(range.files, ['src/a.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
