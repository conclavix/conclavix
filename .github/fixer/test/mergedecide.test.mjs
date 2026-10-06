import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../github.mjs';
import { decideMerge, mergeCommitMessage, validateMergeOutput } from '../mergedecide.mjs';
import { buildMergePrompt, compactSchema } from '../prepare.mjs';

const config = loadConfig();
const TRAILER = config.round_trailer;
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

test('validateMergeOutput accepts reports on the conflicted files only', () => {
  const ok = {
    files: [{ path: 'src/a.ts', decision: 'resolved', resolution: 'both', reasoning: 'r' }],
    extra_edits: [],
    summary: 's',
  };
  assert.equal(validateMergeOutput(ok, ['src/a.ts']), ok);
  assert.equal(validateMergeOutput(ok, ['src/b.ts']), null);
  assert.equal(
    validateMergeOutput({ ...ok, files: [{ ...ok.files[0], decision: 'fixed' }] }, ['src/a.ts']),
    null,
  );
  assert.equal(validateMergeOutput({ ...ok, extra_edits: undefined }, ['src/a.ts']), null);
  assert.equal(validateMergeOutput(null, ['src/a.ts']), null);
});

const GREEN = { install: 'success', check: 'success', smoke: 'success' };
const STATE = {
  up_to_date: false,
  merge: true,
  claude: [{ path: 'src/a.ts' }],
  union: [],
  blocked: [],
};
const OUTPUT = {
  files: [{ path: 'src/a.ts', decision: 'resolved', resolution: 'kept both', reasoning: 'r' }],
  extra_edits: [],
  summary: 's',
};

function merge(overrides = {}) {
  return decideMerge({
    state: STATE,
    output: OUTPUT,
    changed: true,
    violations: [],
    extra: [],
    gates: GREEN,
    startError: null,
    ...overrides,
  });
}

test('decideMerge pushes a fully resolved merge with green gates', () => {
  const d = merge();
  assert.equal(d.push, true);
  assert.equal(d.escalate, false);
  assert.deepEqual(
    d.files.map((f) => [f.path, f.how, f.decision]),
    [['src/a.ts', 'claude', 'resolved']],
  );
  const clean = merge({ state: { ...STATE, claude: [] }, output: null });
  assert.equal(clean.push, true);
  const upToDate = merge({ state: { ...STATE, up_to_date: true } });
  assert.deepEqual([upToDate.push, upToDate.escalate], [false, false]);
});

test('decideMerge escalates semantic conflicts, blocked files, violations and red gates', () => {
  const semantic = merge({
    output: { ...OUTPUT, files: [{ ...OUTPUT.files[0], decision: 'needs_human' }] },
  });
  assert.equal(semantic.push, false);
  assert.match(semantic.causes.join(), /conflict_unresolved: 1 file\(s\) need a human/);
  const blocked = merge({
    state: { ...STATE, merge: false, claude: [], blocked: [{ path: 'pnpm-lock.yaml', why: 'w' }] },
    output: null,
  });
  assert.match(blocked.causes.join(), /conflict_unresolved: conflicts in files/);
  assert.equal(blocked.files[0].how, 'human');
  assert.match(merge({ output: null }).causes.join(), /no valid result/);
  assert.match(
    merge({ output: null, startError: 'bwrap failed' }).causes.join(),
    /Claude could not start: bwrap failed/,
  );
  assert.match(merge({ violations: ['x'] }).causes.join(), /policy violations/);
  assert.match(merge({ extra: ['src/u.ts'] }).causes.join(), /without a reason: src\/u\.ts/);
  const explained = merge({
    extra: ['src/u.ts'],
    output: { ...OUTPUT, extra_edits: [{ path: 'src/u.ts', reason: 'signature' }] },
  });
  assert.equal(explained.push, true);
  const red = merge({ gates: { ...GREEN, check: 'failure' } });
  assert.deepEqual(red.causes, ['gates failed: check']);
  assert.equal(merge({ gates: { ...GREEN, smoke: 'skipped' } }).push, true);
  const missing = merge({ output: { ...OUTPUT, files: [] } });
  assert.match(missing.files[0].reasoning, /did not report/);
  assert.equal(missing.push, false);
});

test('merge commit message names the base, every resolution and the round trailer', () => {
  const d = merge({ output: { ...OUTPUT, extra_edits: [{ path: 'src/u.ts', reason: 'sig' }] } });
  const message = mergeCommitMessage({
    baseRef: 'main',
    headRef: 'feat/x',
    base: B,
    head: A,
    round: 2,
    trailer: TRAILER,
    files: d.files,
    output: { extra_edits: [{ path: 'src/u.ts', reason: 'sig' }] },
  });
  assert.match(message, /^Merge branch 'main' into feat\/x\n/);
  assert.match(message, new RegExp(`at ${B} into the pull request head ${A}`));
  assert.match(message, /- src\/a\.ts \(fixer\)\n {2}Resolution: kept both/);
  assert.match(message, /- src\/u\.ts \(also changed\): sig/);
  assert.match(message, new RegExp(`${TRAILER}: 2\nCo-Authored-By: Claude`));
  const clean = mergeCommitMessage({
    baseRef: 'main',
    headRef: 'feat/x',
    base: B,
    head: A,
    round: 1,
    trailer: TRAILER,
    files: [],
    output: null,
  });
  assert.match(clean, /merged without conflicts/);
  assert.doesNotMatch(clean, /Co-Authored-By/);
});

test('the merge prompt and schema are built from the trusted files', () => {
  const prompt = buildMergePrompt({ inputDir: '/in', round: 1, maxRounds: 3, files: 2 });
  assert.match(prompt, /keeps the intent of BOTH sides/);
  assert.match(prompt, /\/in\/conflicts\.md` \(2 conflicted file\(s\)\)/);
  const schema = JSON.parse(compactSchema(undefined, 'merge-schema.json'));
  assert.deepEqual(schema.properties.files.items.properties.decision.enum, [
    'resolved',
    'needs_human',
  ]);
});
