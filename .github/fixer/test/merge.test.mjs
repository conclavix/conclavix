import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stageAll } from '../collect.mjs';
import { loadConfig } from '../github.mjs';
import {
  checkResolution,
  classifyConflicts,
  parseUnmerged,
  unionPackageJson,
  verifyMergeCommit,
} from '../merge.mjs';
import { prepareMergeState } from '../prepare.mjs';
import { RESOLVED, conflicting, fixture, verify } from './gitfixture.mjs';

const config = loadConfig();
const TRAILER = config.round_trailer;
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

test('parseUnmerged groups the stages of each conflicted path', () => {
  const text = `100644 ${A} 1\tsrc/a.ts\x00100644 ${B} 2\tsrc/a.ts\x00100644 ${C} 3\tsrc/a.ts\x00100644 ${B} 2\tgone.ts\x00`;
  assert.deepEqual(parseUnmerged(text), [
    { path: 'gone.ts', stages: { 2: B }, modes: { 2: '100644' } },
    {
      path: 'src/a.ts',
      stages: { 1: A, 2: B, 3: C },
      modes: { 1: '100644', 2: '100644', 3: '100644' },
    },
  ]);
});

test('classifyConflicts: text conflicts go to Claude, package.json to the union, the rest to a human', () => {
  const text = () => Buffer.from('text\n');
  const entry = (path, stages = { 1: A, 2: B, 3: C }, mode = '100644') => ({
    path,
    stages,
    modes: Object.fromEntries(Object.keys(stages).map((s) => [s, mode])),
  });
  const out = classifyConflicts(
    [
      entry('src/a.ts'),
      entry('apps/web/package.json'),
      entry('pnpm-lock.yaml'),
      entry('pnpm-workspace.yaml'),
      entry('.github/workflows/ci.yml'),
      entry('tsconfig.json'),
      entry('scripts/start-test-mongo.sh'),
      entry('src/gone.ts', { 1: A, 2: B }),
      entry('src/link', { 1: A, 2: B, 3: C }, '120000'),
    ],
    config,
    text,
  );
  assert.deepEqual(
    out.claude.map((c) => c.path),
    ['src/a.ts'],
  );
  assert.deepEqual(
    out.union.map((c) => c.path),
    ['apps/web/package.json'],
  );
  assert.deepEqual(
    out.blocked.map((b) => b.path),
    [
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      '.github/workflows/ci.yml',
      'tsconfig.json',
      'scripts/start-test-mongo.sh',
      'src/gone.ts',
      'src/link',
    ],
  );
  const binary = classifyConflicts([entry('img.png')], config, () => Buffer.from([1, 0, 2]));
  assert.match(binary.blocked[0].why, /binary/);
});

test('unionPackageJson keeps scripts both sides added, refuses real conflicts', () => {
  const base = JSON.stringify({ name: 'x', scripts: { test: 'vitest' } });
  const ours = JSON.stringify({ name: 'x', scripts: { test: 'vitest', smoke: 'node s.js' } });
  const theirs = JSON.stringify({ name: 'x', scripts: { test: 'vitest', lint: 'eslint .' } });
  const ok = unionPackageJson(base, ours, theirs);
  assert.deepEqual(JSON.parse(ok.text).scripts, {
    test: 'vitest',
    smoke: 'node s.js',
    lint: 'eslint .',
  });
  assert.deepEqual(ok.scripts, ['lint', 'smoke']);
  assert.ok(ok.text.endsWith('}\n'));
  const removed = unionPackageJson(
    base,
    JSON.stringify({ name: 'x', scripts: {} }),
    JSON.stringify({ name: 'x', scripts: { test: 'vitest', lint: 'eslint .' } }),
  );
  assert.deepEqual(JSON.parse(removed.text).scripts, { lint: 'eslint .' });
  const same = unionPackageJson(
    base,
    JSON.stringify({ name: 'x', scripts: { test: 'vitest --run' } }),
    JSON.stringify({ name: 'x', scripts: { test: 'vitest --watch' } }),
  );
  assert.match(same.error, /script "test"/);
  const deps = unionPackageJson(
    JSON.stringify({ dependencies: { a: '1' } }),
    JSON.stringify({ dependencies: { a: '2' } }),
    JSON.stringify({ dependencies: { a: '3' } }),
  );
  assert.match(deps.error, /"dependencies"/);
  assert.match(unionPackageJson(base, '{', theirs).error, /valid JSON/);
  assert.deepEqual(JSON.parse(unionPackageJson(null, ours, theirs).text).scripts.lint, 'eslint .');
});

test('verifyMergeCommit: exactly the PR head and the base tip as parents, with the round trailer', () => {
  const base = {
    sha: C,
    parents: [A, B],
    message: `Merge\n\n${TRAILER}: 2\n`,
    head: A,
    base: B,
    round: 2,
    trailer: TRAILER,
    branch: 'feat/x',
  };
  assert.deepEqual(verifyMergeCommit(base), []);
  assert.equal(verifyMergeCommit({ ...base, parents: [A] }).length, 1);
  assert.equal(verifyMergeCommit({ ...base, parents: [B, A] }).length, 1);
  assert.equal(verifyMergeCommit({ ...base, parents: [A, C] }).length, 1);
  assert.equal(verifyMergeCommit({ ...base, parents: [A, B, C] }).length, 1);
  assert.equal(verifyMergeCommit({ ...base, round: 3 }).length, 1);
  assert.equal(verifyMergeCommit({ ...base, branch: '-x' }).length, 1);
  assert.equal(verifyMergeCommit({ ...base, base: 'main' }).length, 2);
});

test('verify accepts a merge commit that only resolves the conflict', (t) => {
  const f = conflicting();
  t.after(f.cleanup);
  const sha = f.merge(f.head, f.base, { 'src/a.ts': RESOLVED });
  assert.deepEqual(verify(f, sha), []);
  const result = checkResolution({ cwd: f.dir, head: f.head, base: f.base, tree: sha, config });
  assert.deepEqual(result.conflicts, ['src/a.ts']);
  assert.deepEqual(result.extra, []);
});

test('verify rejects wrong parents, extra commits and a missing trailer', (t) => {
  const f = conflicting();
  t.after(f.cleanup);
  const single = f.merge(f.head, f.base, { 'src/a.ts': RESOLVED }, [f.head]);
  assert.match(verify(f, single).join('\n'), /exactly two parents/);
  const swapped = f.merge(f.head, f.base, { 'src/a.ts': RESOLVED }, [f.base, f.head]);
  assert.match(verify(f, swapped).join('\n'), /exactly two parents/);
  const older = f.merge(f.head, f.base, { 'src/a.ts': RESOLVED }, [f.head, f.root]);
  assert.match(verify(f, older).join('\n'), /exactly two parents/);
  f.git('checkout', '-q', '--detach', f.head);
  const extra = f.commit({ 'src/b.ts': 'export const x = 1;\n' }, 'extra');
  const onTop = f.merge(extra, f.base, { 'src/a.ts': RESOLVED }, [extra, f.base]);
  assert.match(verify(f, onTop).join('\n'), /exactly two parents/);
  const noTrailer = f.merge(f.head, f.base, { 'src/a.ts': RESOLVED }, undefined, 'merge\n');
  assert.match(verify(f, noTrailer).join('\n'), /round 1/);
});

test('verify rejects markers, dropped files and edits to protected files outside the conflict', (t) => {
  const f = conflicting({ 'scripts/run.sh': 'echo a\n', 'src/util.ts': 'export const u = 1;\n' });
  t.after(f.cleanup);
  const markers = f.merge(f.head, f.base, {});
  assert.match(verify(f, markers).join('\n'), /src\/a\.ts: conflict markers/);
  const deleted = f.merge(f.head, f.base, { 'src/a.ts': null });
  assert.match(verify(f, deleted).join('\n'), /conflicted file was deleted/);
  const guarded = f.merge(f.head, f.base, {
    'src/a.ts': RESOLVED,
    'scripts/run.sh': 'echo b\n',
  });
  assert.match(verify(f, guarded).join('\n'), /scripts\/run\.sh: guarded path/);
  const weakened = f.merge(f.head, f.base, {
    'src/a.ts': `${RESOLVED}// eslint-disable-next-line\n`,
  });
  assert.match(verify(f, weakened).join('\n'), /eslint-disable/);
  const adapted = f.merge(f.head, f.base, {
    'src/a.ts': RESOLVED,
    'src/util.ts': 'export const u = 2;\n',
  });
  assert.deepEqual(verify(f, adapted), []);
  const big = f.merge(f.head, f.base, {
    'src/a.ts': RESOLVED,
    'src/util.ts': `${'export const z = 0;\n'.repeat(config.merge.max_extra_lines + 1)}`,
  });
  assert.match(verify(f, big).join('\n'), /outside the conflicted files/);
});

test('verify never accepts a conflict in the lockfile, the workspace file or CI', (t) => {
  for (const path of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', '.github/workflows/ci.yml']) {
    const f = conflicting({ [path]: 'a: 1\n' }, { [path]: 'a: 2\n' }, { [path]: 'a: 3\n' });
    t.after(f.cleanup);
    const sha = f.merge(f.head, f.base, { 'src/a.ts': RESOLVED, [path]: 'a: 2\n' });
    const problems = verify(f, sha).join('\n');
    assert.match(problems, new RegExp(`${path.replace(/[./]/g, '\\$&')}: .*never resolves`));
  }
});

test('verify accepts a package.json union exactly as computed and nothing else', (t) => {
  const pkg = (scripts) => `${JSON.stringify({ name: 'x', scripts }, null, 2)}\n`;
  const f = conflicting(
    { 'package.json': pkg({ test: 'vitest' }) },
    { 'package.json': pkg({ test: 'vitest', smoke: 'node s.js' }) },
    { 'package.json': pkg({ test: 'vitest', lint: 'eslint .' }) },
  );
  t.after(f.cleanup);
  const union = pkg({ test: 'vitest', smoke: 'node s.js', lint: 'eslint .' });
  const ok = f.merge(f.head, f.base, { 'src/a.ts': RESOLVED, 'package.json': union });
  assert.deepEqual(verify(f, ok), []);
  const other = f.merge(f.head, f.base, {
    'src/a.ts': RESOLVED,
    'package.json': pkg({ test: 'vitest', smoke: 'node s.js' }),
  });
  assert.match(verify(f, other).join('\n'), /package\.json: must be the union/);
});

test('verify: a clean merge must be exactly git merge, a modify/delete conflict needs a human', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  f.commit({ 'a.ts': '1\n', 'b.ts': '1\n', 'c.ts': '1\n' }, 'base');
  f.git('checkout', '-q', '-b', 'pr');
  const head = f.commit({ 'a.ts': '2\n' }, 'pr');
  f.git('checkout', '-q', 'main');
  const base = f.commit({ 'b.ts': '2\n' }, 'main');
  const ctx = { ...f, head, base };
  assert.deepEqual(verify(ctx, f.merge(head, base, {})), []);
  const changed = f.merge(head, base, { 'c.ts': '2\n' });
  assert.match(verify(ctx, changed).join('\n'), /differs from that merge/);
  f.git('checkout', '-q', 'main');
  const deleted = f.commit({ 'a.ts': null }, 'main deletes a');
  const md = { ...f, head, base: deleted };
  const sha = f.merge(head, deleted, { 'a.ts': '2\n' });
  assert.match(verify(md, sha).join('\n'), /a\.ts: one side deleted or renamed/);
});

test('prepareMergeState merges without committing and sorts the conflicts', (t) => {
  const pkg = (scripts) => `${JSON.stringify({ name: 'x', scripts }, null, 2)}\n`;
  const f = conflicting(
    { 'package.json': pkg({ test: 'vitest' }) },
    { 'package.json': pkg({ test: 'vitest', smoke: 'node s.js' }) },
    { 'package.json': pkg({ test: 'vitest', lint: 'eslint .' }) },
  );
  t.after(f.cleanup);
  const state = prepareMergeState({ cwd: f.dir, head: f.head, base: f.base, config });
  assert.equal(state.merge, true);
  assert.equal(state.up_to_date, false);
  assert.deepEqual(state.claude, [{ path: 'src/a.ts' }]);
  assert.deepEqual(state.union, [{ path: 'package.json', scripts: ['lint', 'smoke'] }]);
  assert.deepEqual(state.blocked, []);
  assert.equal(f.git('rev-parse', 'HEAD'), f.head);
  assert.match(readFileSync(join(f.dir, 'src/a.ts'), 'utf8'), /<<<<<<< /);
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'package.json'), 'utf8')).scripts, {
    test: 'vitest',
    smoke: 'node s.js',
    lint: 'eslint .',
  });
  writeFileSync(join(f.dir, 'src/a.ts'), RESOLVED);
  const tree = stageAll(f.dir);
  const check = checkResolution({ cwd: f.dir, head: f.head, base: f.base, tree, config });
  assert.deepEqual(check.violations, []);
  const sha = f.git('commit-tree', tree, '-p', f.head, '-p', f.base, '-m', `m\n\n${TRAILER}: 1`);
  assert.deepEqual(verify(f, sha), []);
});

test('prepareMergeState stops before Claude on a lockfile conflict and reports up-to-date heads', (t) => {
  const f = conflicting(
    { 'pnpm-lock.yaml': 'a: 1\n' },
    { 'pnpm-lock.yaml': 'a: 2\n' },
    { 'pnpm-lock.yaml': 'a: 3\n' },
  );
  t.after(f.cleanup);
  const state = prepareMergeState({ cwd: f.dir, head: f.head, base: f.base, config });
  assert.equal(state.merge, false);
  assert.deepEqual(state.claude, []);
  assert.deepEqual(
    state.blocked.map((b) => b.path),
    ['pnpm-lock.yaml'],
  );
  const g = fixture();
  t.after(g.cleanup);
  const root = g.commit({ 'a.ts': '1\n' }, 'base');
  const head = g.commit({ 'a.ts': '2\n' }, 'pr');
  g.git('checkout', '-q', '--detach', head);
  const done = prepareMergeState({ cwd: g.dir, head, base: root, config });
  assert.equal(done.up_to_date, true);
  assert.equal(done.merge, false);
});

test('verify accepts a base the branch moved past, but only a commit that is on the branch', (t) => {
  const f = conflicting();
  t.after(f.cleanup);
  const sha = f.merge(f.head, f.base, { 'src/a.ts': RESOLVED });
  f.git('checkout', '-q', 'main');
  const newer = f.commit({ 'README.md': 'y\n' }, 'main moves on');
  assert.deepEqual(verify(f, sha, { baseTip: newer }), []);
  f.git('checkout', '-q', '--detach', f.head);
  const side = f.commit({ 'README.md': 'z\n' }, 'not on main');
  const off = f.merge(f.head, side, { 'src/a.ts': RESOLVED }, [f.head, side]);
  const problems = verify({ ...f, base: side }, off, { baseTip: newer }).join('\n');
  assert.match(problems, /is not on the base branch/);
});
