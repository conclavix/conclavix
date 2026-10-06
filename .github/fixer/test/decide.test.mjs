import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitMessage, decide, validateOutput } from '../decide.mjs';
import { extractRun, startFailure } from '../finalize.mjs';
import { verifyCommit } from '../verify.mjs';

const F1 = {
  id: 'F1',
  file: 'apps/api/src/a.ts',
  line: 10,
  rule: 'B3',
  title: 'Lock is never released',
};
const F2 = {
  id: 'F2',
  file: 'apps/api/src/b.ts',
  line: 4,
  rule: 'B1',
  title: 'Writes are not atomic',
};
const GREEN = { install: 'success', check: 'success', smoke: 'skipped' };

function out(findings, extra = {}) {
  return {
    findings,
    commit_subject: 'fix(api): release the lock on errors',
    summary: 'done',
    ...extra,
  };
}

const fixed = (id) => ({
  id,
  decision: 'fixed',
  explanation: 'release in finally',
  proof_test: 'pnpm test x',
  proof_failed_before: true,
});

function run(overrides = {}) {
  return decide({
    selected: [F1],
    scope: [],
    output: out([fixed('F1')]),
    changed: true,
    violations: [],
    gates: GREEN,
    ...overrides,
  });
}

test('validateOutput accepts known ids and decisions only', () => {
  assert.ok(validateOutput(out([fixed('F1')]), ['F1']));
  assert.equal(validateOutput(out([{ ...fixed('F9') }]), ['F1']), null);
  assert.equal(
    validateOutput(out([{ id: 'F1', decision: 'maybe', explanation: '' }]), ['F1']),
    null,
  );
  assert.equal(validateOutput(null, ['F1']), null);
  assert.equal(validateOutput({ findings: [] }, ['F1']), null);
});

test('a proven fix with green gates is pushed without escalation', () => {
  assert.deepEqual(run(), { push: true, escalate: false, causes: [], fixed: ['F1'], open: [] });
});

test('failing gates, policy violations and odd changes stop the push', () => {
  const gates = run({ gates: { install: 'success', check: 'failure', smoke: 'skipped' } });
  assert.equal(gates.push, false);
  assert.match(gates.causes[0], /gates failed: check/);
  assert.match(
    run({ gates: { install: 'success', check: 'success', smoke: 'failure' } }).causes[0],
    /smoke/,
  );
  const policy = run({ violations: ['x'] });
  assert.equal(policy.push, false);
  assert.deepEqual(policy.causes, ['policy violations']);
  assert.equal(run({ changed: false }).push, false);
  const stray = run({ output: out([{ id: 'F1', decision: 'disputed', explanation: 'wrong' }]) });
  assert.equal(stray.push, false);
  assert.match(stray.causes[0], /no finding is reported as fixed/);
});

test('disputed, human and missing findings escalate next to a pushed fix', () => {
  const result = run({
    selected: [F1, F2],
    output: out([fixed('F1')]),
    scope: [{ id: 'S1', description: 'adds an unrelated page' }],
  });
  assert.equal(result.push, true);
  assert.equal(result.escalate, true);
  assert.deepEqual(
    result.open.map((o) => [o.id, o.decision]),
    [
      ['F2', 'needs_human'],
      ['S1', 'scope'],
    ],
  );
  const disputed = run({
    changed: false,
    output: out([{ id: 'F1', decision: 'disputed', explanation: 'no race' }]),
  });
  assert.equal(disputed.push, false);
  assert.equal(disputed.escalate, true);
  assert.equal(disputed.open[0].decision, 'disputed');
});

test('a fix without a failing proof test is pushed but escalated', () => {
  const result = run({ output: out([{ ...fixed('F1'), proof_failed_before: false }]) });
  assert.equal(result.push, true);
  assert.equal(result.escalate, true);
  assert.match(result.causes[0], /no failing proof test for F1/);
});

test('no result or nothing to fix escalates', () => {
  assert.match(run({ output: null }).causes[0], /no valid result/);
  assert.match(run({ selected: [] }).causes[0], /no fixable findings/);
});

test('a Claude start failure is named instead of a missing result', () => {
  const result = run({ output: null, startError: 'bwrap: setting up uid map: Permission denied' });
  assert.equal(result.push, false);
  assert.equal(result.escalate, true);
  assert.deepEqual(result.causes, [
    'Claude could not start: bwrap: setting up uid map: Permission denied',
  ]);
  assert.deepEqual(run({ startError: 'ignored' }).causes, []);
});

test('startFailure takes the first sandbox error line, else flags a step that wrote nothing', () => {
  const errorText = '\n  bubblewrap self-test failed: bwrap: loopback: Failed RTM_NEWADDR\nmore\n';
  const failed = { sandboxOutcome: 'failure', claudeOutcome: 'skipped', messages: [] };
  assert.equal(
    startFailure({ ...failed, errorText }),
    'bubblewrap self-test failed: bwrap: loopback: Failed RTM_NEWADDR',
  );
  assert.equal(startFailure({ ...failed, errorText: 'x'.repeat(500) }).length, 240);
  assert.match(startFailure({ ...failed, errorText: '' }), /sandbox step failed/);
  const ran = { sandboxOutcome: 'success', claudeOutcome: 'failure' };
  assert.match(
    startFailure({ ...ran, errorText: 'written by a test', messages: [] }),
    /failed before it produced any output/,
  );
  assert.equal(startFailure({ ...ran, errorText: '', messages: [{ type: 'system' }] }), null);
  assert.equal(
    startFailure({
      errorText: 'x',
      sandboxOutcome: 'success',
      claudeOutcome: 'success',
      messages: [],
    }),
    null,
  );
  assert.equal(startFailure({ errorText: undefined, messages: null }), null);
});

test('commit message lists the fixed findings, proof, round trailer and attribution', () => {
  const message = commitMessage({
    output: out([fixed('F1'), { id: 'F2', decision: 'disputed', explanation: 'x' }]),
    selected: [F1, F2],
    round: 2,
    trailer: 'Conclavix-Fixer-Round',
    reviewRun: 'https://example.test/run/1',
  });
  assert.match(message, /^fix\(api\): release the lock on errors\n\n/);
  assert.match(message, /- F1 B3 apps\/api\/src\/a.ts:10: Lock is never released/);
  assert.match(message, /Proof: pnpm test x \(failed before the fix\)/);
  assert.doesNotMatch(message, /F2/);
  assert.match(
    message,
    /\nConclavix-Fixer-Round: 2\nCo-Authored-By: Claude <noreply@anthropic.com>\n$/,
  );
  const odd = commitMessage({
    output: out([fixed('F1')], { commit_subject: 'feat: new page\n\nX' }),
    selected: [F1],
    round: 1,
    trailer: 'T',
    reviewRun: 'u',
  });
  assert.match(odd, /^fix: address blocking review findings \(round 1\)\n/);
});

test('extractRun reads the structured output and metrics of the last result', () => {
  const messages = [
    { type: 'system', subtype: 'init' },
    {
      type: 'result',
      subtype: 'success',
      total_cost_usd: 1.5,
      duration_ms: 60000,
      num_turns: 9,
      structured_output: { a: 1 },
      permission_denials: [{}],
    },
  ];
  const { output, metrics } = extractRun(messages);
  assert.deepEqual(output, { a: 1 });
  assert.equal(metrics.total_cost_usd, 1.5);
  assert.equal(metrics.permission_denials, 1);
  assert.deepEqual(extractRun(null), { output: null, metrics: null });
});

test('verifyCommit accepts one commit on the head with the round trailer only', () => {
  const head = 'a'.repeat(40);
  const base = {
    sha: 'b'.repeat(40),
    parents: [head],
    message: 'fix: x\n\nT: 1\n',
    head,
    round: 1,
    trailer: 'T',
    branch: 'feat/x',
  };
  assert.deepEqual(verifyCommit(base), []);
  assert.equal(verifyCommit({ ...base, parents: [head, 'c'.repeat(40)] }).length, 1);
  assert.equal(verifyCommit({ ...base, parents: ['c'.repeat(40)] }).length, 1);
  assert.equal(verifyCommit({ ...base, round: 2 }).length, 1);
  assert.equal(verifyCommit({ ...base, branch: '-x' }).length, 1);
  assert.equal(verifyCommit({ ...base, branch: 'a..b' }).length, 1);
});

const C1 = { id: 'C1', rule: 'CI', title: 'check / Run pnpm format:check', run_url: 'u' };
const ciFixed = (id) => ({
  id,
  decision: 'fixed',
  explanation: 'format the file',
  proof_test: 'pnpm format:check',
  proof_failed_before: true,
});

test('validateOutput: CI items allow not_reproducible, findings do not', () => {
  const ids = ['F1', 'C1'];
  const ok = out([fixed('F1'), { id: 'C1', decision: 'not_reproducible', explanation: 'x' }]);
  assert.ok(validateOutput(ok, ids));
  assert.equal(
    validateOutput(out([{ id: 'F1', decision: 'not_reproducible', explanation: 'x' }]), ids),
    null,
  );
  assert.equal(
    validateOutput(out([{ id: 'C1', decision: 'disputed', explanation: 'x' }]), ids),
    null,
  );
});

test('a proven CI fix with green gates is pushed without escalation', () => {
  const r = run({ selected: [C1], output: out([ciFixed('C1')]) });
  assert.deepEqual(r, { push: true, escalate: false, causes: [], fixed: ['C1'], open: [] });
  const both = run({ selected: [F1, C1], output: out([fixed('F1'), ciFixed('C1')]) });
  assert.deepEqual(both.fixed, ['F1', 'C1']);
  assert.equal(both.escalate, false);
});

test('a CI fix needs the failing command as proof and passes the same gates and policy', () => {
  const unproven = run({
    selected: [C1],
    output: out([{ ...ciFixed('C1'), proof_failed_before: false }]),
  });
  assert.equal(unproven.escalate, true);
  assert.match(unproven.causes[0], /no failing proof test for C1/);
  assert.equal(
    run({ selected: [C1], output: out([ciFixed('C1')]), violations: ['x'] }).push,
    false,
  );
  const red = run({
    selected: [C1],
    output: out([ciFixed('C1')]),
    gates: { install: 'success', check: 'failure', smoke: 'skipped' },
  });
  assert.equal(red.push, false);
  assert.match(red.causes[0], /gates failed: check/);
});

test('not reproducible CI failures and infra failures escalate as ci_infra', () => {
  const flaky = run({
    selected: [C1],
    changed: false,
    output: out([{ id: 'C1', decision: 'not_reproducible', explanation: 'passes locally' }]),
  });
  assert.equal(flaky.push, false);
  assert.equal(flaky.escalate, true);
  assert.ok(flaky.causes.some((c) => c.startsWith('ci_infra:')));
  assert.equal(flaky.open[0].decision, 'not_reproducible');
  const infra = [{ id: 'I1', why: 'a setup step failed' }];
  const onlyInfra = run({ selected: [], ciInfra: infra });
  assert.match(onlyInfra.causes[0], /^ci_infra:/);
  assert.deepEqual(onlyInfra.open, [
    { id: 'I1', decision: 'ci_infra', explanation: 'a setup step failed' },
  ]);
  const mixed = run({ ciInfra: infra });
  assert.equal(mixed.push, true);
  assert.equal(mixed.escalate, true);
  assert.ok(mixed.causes.some((c) => c.startsWith('ci_infra:')));
  assert.match(run({ output: null, ciInfra: infra }).causes[0], /no valid result/);
});

test('commit message lists fixed CI steps with their proof and the CI run', () => {
  const message = commitMessage({
    output: out([ciFixed('C1')], { commit_subject: 'bad' }),
    selected: [C1],
    round: 1,
    trailer: 'Conclavix-Fixer-Round',
    reviewRun: '',
    ciRuns: ['https://example.test/runs/1'],
  });
  assert.match(message, /^fix: make the failing CI steps pass \(round 1\)\n/);
  assert.match(message, /Fixer round 1\. Failed CI steps addressed:/);
  assert.match(message, /- C1 CI check \/ Run pnpm format:check\n {2}Fix: format the file\n/);
  assert.match(message, /Proof: pnpm format:check \(failed before the fix\)/);
  assert.match(message, /CI run: https:\/\/example.test\/runs\/1\n/);
  assert.doesNotMatch(message, /Review run:/);
  const mixed = commitMessage({
    output: out([fixed('F1'), ciFixed('C1')]),
    selected: [F1, C1],
    round: 2,
    trailer: 'T',
    reviewRun: 'r',
    ciRuns: [],
  });
  assert.match(mixed, /Blocking review findings and failed CI steps addressed:/);
  assert.match(mixed, /Review run: r\n/);
});

test('startFailure names a frozen-lockfile install failure before anything else', () => {
  assert.match(
    startFailure({ depsOutcome: 'failure', sandboxOutcome: 'success', messages: [] }),
    /frozen lockfile/,
  );
  assert.equal(
    startFailure({
      depsOutcome: 'success',
      sandboxOutcome: 'success',
      claudeOutcome: 'success',
      messages: [{}],
    }),
    null,
  );
});
