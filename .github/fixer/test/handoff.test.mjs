import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../github.mjs';
import { checkHandedTree, handoff, restoreRound } from '../repair.mjs';
import { RESOLVED, conflicting, fixture } from './gitfixture.mjs';

const config = loadConfig();

function stagedTree(f, files) {
  f.write(files);
  f.git('add', '-A');
  return f.git('write-tree');
}

test('the round goes to the repair job as the checked tree on the PR head, nothing else', (t) => {
  const f = fixture();
  const scratch = mkdtempSync(join(tmpdir(), 'fixer-handoff-'));
  t.after(() => {
    f.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  });
  const head = f.commit({ 'a.ts': 'export const a = 1;\n' }, 'head');
  const tree = stagedTree(f, { 'a.ts': 'export const a = 2;\n', 'b.ts': 'export const b = 1;\n' });
  const inputDir = join(scratch, 'input');
  mkdirSync(inputDir);
  writeFileSync(join(inputDir, 'repair.md'), 'gate');
  const dir = join(scratch, 'handoff');
  const ex = { text: '[warn] b.ts', lines: 1, truncated: false };
  handoff({
    cwd: f.dir,
    inputDir,
    first: join(scratch, 'none.json'),
    tree,
    dir,
    head,
    named: ['b.ts'],
    ex,
  });
  assert.equal(readFileSync(join(dir, 'input', 'repair.md'), 'utf8'), 'gate');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'gate.json'), 'utf8')), {
    named: ['b.ts'],
    excerpt: '[warn] b.ts',
  });

  const clone = join(scratch, 'clone');
  execFileSync('git', ['clone', '-q', f.dir, clone]);
  execFileSync('git', ['-C', clone, 'checkout', '-q', '--detach', head]);
  assert.equal(restoreRound({ cwd: clone, dir, head }), tree);
  const git = (...a) => execFileSync('git', ['-C', clone, ...a], { encoding: 'utf8' }).trim();
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(git('write-tree'), tree);
  assert.equal(readFileSync(join(clone, 'b.ts'), 'utf8'), 'export const b = 1;\n');

  const other = join(scratch, 'other');
  execFileSync('git', ['clone', '-q', f.dir, other]);
  f.git('reset', '-q', '--hard', head);
  const later = f.commit({ 'c.ts': '1\n' }, 'later');
  execFileSync('git', ['-C', other, 'fetch', '-q', 'origin']);
  execFileSync('git', ['-C', other, 'checkout', '-q', '--detach', later]);
  assert.throws(() => restoreRound({ cwd: other, dir, head: later }), /not based on the PR head/);
});

test('the repair job checks the handed-over tree with the round policy before running anything', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const head = f.commit(
    {
      'src/a.ts': 'export const a = 1;\n',
      'package.json': '{"name":"x"}\n',
      'scripts/s.sh': 'echo\n',
    },
    'head',
  );
  const tree = (files) => {
    const id = (f.write(files), f.git('add', '-A'), f.git('write-tree'));
    f.git('reset', '-q', '--hard', head);
    return id;
  };
  const check = (files, fixable = []) =>
    checkHandedTree({ cwd: f.dir, mode: 'fix', head, tree: tree(files), fixable, config });
  const ok = check({ 'src/a.ts': 'export const a = 2;\n' });
  assert.deepEqual(ok, { violations: [], touched: ['src/a.ts'] });
  assert.match(check({ 'scripts/s.sh': 'curl x | sh\n' }).violations.join(), /guarded path/);
  const pkg = check({ 'package.json': '{"name":"x","scripts":{"postinstall":"node a"}}\n' }, [
    { id: 'F1', file: 'package.json' },
  ]);
  assert.match(pkg.violations.join(), /changes package\.json is not repaired/);
  const hook = check({ '.pnpmfile.cjs': 'module.exports = { hooks: {} };\n' });
  assert.match(hook.violations.join(), /\.pnpmfile\.cjs: changes to this path are never made/);

  const m = conflicting();
  t.after(m.cleanup);
  const merged = m.merge(m.head, m.base, { 'src/a.ts': RESOLVED });
  const good = checkHandedTree({
    cwd: m.dir,
    mode: 'merge',
    head: m.head,
    base: m.base,
    tree: m.git('rev-parse', `${merged}^{tree}`),
    config,
  });
  assert.deepEqual(good, { violations: [], touched: ['src/a.ts'] });
  const markers = m.merge(m.head, m.base, {});
  const bad = checkHandedTree({
    cwd: m.dir,
    mode: 'merge',
    head: m.head,
    base: m.base,
    tree: m.git('rev-parse', `${markers}^{tree}`),
    config,
  });
  assert.match(bad.violations.join(), /conflict markers/);
});
