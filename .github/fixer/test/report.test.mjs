import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../github.mjs';
import { metricsLine, plan } from '../report.mjs';

const config = loadConfig();
const SHA = 'c'.repeat(40);
const MENTION = new RegExp(`@${config.escalation_mention}\\b`);
const LEADING_MENTION = new RegExp(`^@${config.escalation_mention} `);

function outcome(overrides = {}) {
  return {
    push: true,
    commit: SHA,
    escalate: false,
    causes: [],
    fixed: [
      {
        id: 'F1',
        rule: 'B3',
        file: 'a.ts',
        line: 3,
        title: 'Lock stays held',
        explanation: 'release in finally',
      },
    ],
    open: [],
    violations: [],
    gates: { install: 'success', check: 'success', smoke: 'skipped' },
    ...overrides,
  };
}

function report(overrides = {}) {
  return plan({
    config,
    mode: 'fix',
    routeReason: 'review failed',
    dropReady: false,
    headSha: 'a'.repeat(40),
    outcome: outcome(),
    fixResult: 'success',
    pushResult: 'success',
    pushedSha: SHA,
    runUrl: 'https://example.test/run',
    round: 1,
    ...overrides,
  });
}

test('a pushed fix comments without escalating', () => {
  const r = report();
  assert.deepEqual(r.add, []);
  assert.match(r.comment, /round 1 of 3/);
  assert.match(r.comment, new RegExp(`Pushed \`${SHA}\``));
  assert.doesNotMatch(r.comment, MENTION);
});

test('open findings escalate with label, mention and the fixer explanation', () => {
  const r = report({
    outcome: outcome({
      escalate: true,
      causes: ['findings left for a human'],
      open: [
        {
          id: 'F2',
          decision: 'disputed',
          title: 'Race',
          file: 'b.ts',
          line: 1,
          explanation: 'ping @someone <!-- x -->',
        },
      ],
    }),
  });
  assert.deepEqual(r.add, ['needs-human']);
  assert.deepEqual(r.remove, ['merge-ready']);
  assert.match(r.comment, LEADING_MENTION);
  assert.match(r.comment, /disputed by the fixer/);
  assert.doesNotMatch(r.comment, /@someone|<!--/);
});

test('a failed fix job or a refused push escalates', () => {
  const failed = report({ fixResult: 'failure', outcome: null });
  assert.deepEqual(failed.add, ['needs-human']);
  assert.match(failed.comment, /failed before it produced a result \(job result: failure\)/);
  const afterDecision = report({
    mode: 'merge',
    fixResult: 'failure',
    outcome: mergeOutcome({ push: false, escalate: true, causes: ['gates failed: check'] }),
  });
  assert.match(afterDecision.comment, /Why it stopped: gates failed: check/);
  const refused = report({ pushResult: 'failure', pushedSha: '' });
  assert.deepEqual(refused.add, ['needs-human']);
  assert.match(refused.comment, /could not be pushed/);
  const blocked = report({
    outcome: outcome({
      push: false,
      commit: null,
      escalate: true,
      causes: ['gates failed: check'],
      gates: { install: 'success', check: 'failure', smoke: 'skipped' },
    }),
  });
  assert.match(blocked.comment, /gates failed: check/);
  assert.match(blocked.comment, /check failure/);
});

test('round limit escalations name what is still open, not always the review', () => {
  const ciOnly = report({
    mode: 'escalate',
    routeReason: 'round_limit',
    routeDetail: 'CI is still red.',
    outcome: null,
  });
  assert.deepEqual(ciOnly.add, ['needs-human']);
  assert.match(ciOnly.comment, /used all of its rounds/);
  assert.match(ciOnly.comment, /- CI is still red\./);
  assert.doesNotMatch(ciOnly.comment, /blocking findings/);
  const conflict = report({
    mode: 'escalate',
    routeReason: 'round_limit',
    routeDetail: 'The branch still has merge conflicts with its base.',
    outcome: null,
  });
  assert.match(conflict.comment, /merge conflicts with its base/);
});

test('ready labels merge-ready, clears needs-human and never merges', () => {
  const r = report({ mode: 'ready', outcome: null });
  assert.deepEqual(r.add, ['merge-ready']);
  assert.deepEqual(r.remove, ['needs-human']);
  assert.match(r.comment, /Nothing is merged automatically/);
});

test('none only drops a stale merge-ready label', () => {
  assert.deepEqual(report({ mode: 'none', dropReady: true }), {
    add: [],
    remove: ['merge-ready'],
    comment: null,
  });
  assert.deepEqual(report({ mode: 'none' }), { add: [], remove: [], comment: null });
});

test('a pushed CI fix lists the addressed CI step, how and the proof', () => {
  const r = report({
    outcome: outcome({
      fixed: [
        {
          id: 'C1',
          rule: 'CI',
          title: 'check / Run pnpm format:check',
          explanation: 'formatted repository.ts with prettier',
          proof_test: 'pnpm format:check',
        },
      ],
    }),
  });
  assert.deepEqual(r.add, []);
  assert.match(
    r.comment,
    /- \*\*C1\*\* CI: check \/ Run pnpm format:check\n {2}formatted repository.ts/,
  );
  assert.match(r.comment, /Proof: pnpm format:check/);
});

test('ci_infra escalations name the failed steps without the log', () => {
  const r = report({
    mode: 'escalate',
    routeReason: 'ci_infra',
    routeDetail: 'CI / check / Set up job: a setup step failed\n@someone <!-- x -->',
    outcome: null,
  });
  assert.deepEqual(r.add, ['needs-human']);
  assert.match(r.comment, /reason outside the code/);
  assert.match(r.comment, /- CI \/ check \/ Set up job: a setup step failed/);
  assert.doesNotMatch(r.comment, /@someone|<!--/);
  const open = report({
    outcome: outcome({
      push: false,
      commit: null,
      escalate: true,
      fixed: [],
      causes: ['ci_infra: CI failed for a reason outside the code'],
      open: [
        {
          id: 'C1',
          rule: 'CI',
          title: 'check / Run pnpm test',
          decision: 'not_reproducible',
          explanation: 'passes locally',
        },
      ],
    }),
  });
  assert.match(open.comment, /\*\*C1\*\* CI: check \/ Run pnpm test \(CI failure not reproducible/);
  assert.match(open.comment, /Why it stopped: ci_infra:/);
});

test('a Claude start failure escalates with the cause in the comment', () => {
  const r = report({
    outcome: outcome({
      push: false,
      commit: null,
      escalate: true,
      causes: ['Claude could not start: bwrap: setting up uid map: Permission denied'],
      fixed: [],
      gates: { install: 'skipped', check: 'skipped', smoke: 'skipped' },
    }),
  });
  assert.deepEqual(r.add, ['needs-human']);
  assert.match(
    r.comment,
    /Why it stopped: Claude could not start: bwrap: setting up uid map: Permission denied\./,
  );
});

function mergeOutcome(overrides = {}) {
  return {
    kind: 'merge',
    push: true,
    commit: SHA,
    escalate: false,
    causes: [],
    base_ref: 'main',
    base_sha: 'b'.repeat(40),
    up_to_date: false,
    files: [
      {
        path: 'apps/api/src/a.ts',
        how: 'claude',
        decision: 'resolved',
        resolution: 'kept the new guard from main and the renamed call from the PR',
        reasoning: 'the two changes touch different conditions',
      },
      {
        path: 'package.json',
        how: 'union',
        decision: 'resolved',
        resolution: "union of both sides' scripts (lint, smoke)",
        reasoning: 'each side changed different scripts',
      },
    ],
    extra_edits: [{ path: 'apps/api/src/b.ts', reason: 'adapted a call to the new signature' }],
    fixed: [],
    open: [],
    violations: [],
    gates: { install: 'success', check: 'success', smoke: 'success' },
    ...overrides,
  };
}

test('a pushed merge lists every conflicted file and how it was resolved', () => {
  const r = report({ mode: 'merge', outcome: mergeOutcome() });
  assert.deepEqual(r.add, []);
  assert.match(r.comment, /Merged `main` \(`b{40}`\) into this branch with `c{40}`/);
  assert.match(
    r.comment,
    /`apps\/api\/src\/a\.ts` \(resolved by the fixer\)\n {2}Resolution: kept/,
  );
  assert.match(r.comment, /`package\.json` \(union of both sides' package\.json scripts\)/);
  assert.match(r.comment, /`apps\/api\/src\/b\.ts`: adapted a call/);
  assert.match(r.comment, /CI and the review run again/);
  assert.doesNotMatch(r.comment, MENTION);
});

test('an unresolved merge escalates with the files, the reason and the gates', () => {
  const r = report({
    mode: 'merge',
    outcome: mergeOutcome({
      push: false,
      commit: null,
      escalate: true,
      causes: ['conflict_unresolved: 1 file(s) need a human decision'],
      files: [
        {
          path: 'apps/api/src/a.ts',
          how: 'claude',
          decision: 'needs_human',
          resolution: '',
          reasoning: 'both sides rewrote the retry condition differently',
        },
      ],
      extra_edits: [],
      gates: { install: 'skipped', check: 'skipped', smoke: 'skipped' },
    }),
  });
  assert.deepEqual(r.add, ['needs-human']);
  assert.match(r.comment, LEADING_MENTION);
  assert.match(r.comment, /Merging `main` into this branch needs you/);
  assert.match(r.comment, /`apps\/api\/src\/a\.ts` \(needs a human\)\n {2}Why: both sides rewrote/);
  assert.match(r.comment, /Why it stopped: conflict_unresolved/);
  const gate = report({
    mode: 'merge',
    outcome: mergeOutcome({
      push: false,
      escalate: true,
      causes: ['gates failed: check'],
      gates: { install: 'success', check: 'failure', smoke: 'skipped' },
    }),
  });
  assert.match(gate.comment, /gates failed: check/);
  assert.match(gate.comment, /check failure/);
});

test('a refused merge push escalates with the workflow-scope hint; up-to-date heads only comment', () => {
  const refused = report({ mode: 'merge', outcome: mergeOutcome(), pushResult: 'failure' });
  assert.deepEqual(refused.add, ['needs-human']);
  assert.match(refused.comment, /could not be pushed/);
  assert.match(refused.comment, /`workflow` scope on `FIXER_BOT_PAT`/);
  const done = report({
    mode: 'merge',
    outcome: mergeOutcome({ up_to_date: true, push: false, commit: null, files: [] }),
  });
  assert.deepEqual(done.add, []);
  assert.match(done.comment, /already contains `main`/);
});

const REPAIR = {
  gate: 'check',
  decision: 'repaired',
  edits: [{ path: 'apps/api/src/modules/issues/repository.ts', reason: 'prettier --write' }],
  summary: 'formatted the file prettier reported',
  violations: [],
};

test('a pushed round names the gate repair and its edits', () => {
  const merged = report({ mode: 'merge', outcome: mergeOutcome({ repair: REPAIR }) });
  assert.match(merged.comment, /`pnpm check` failed after the change; one repair pass made/);
  assert.match(merged.comment, /`apps\/api\/src\/modules\/issues\/repository\.ts`: prettier/);
  const fixed = report({ outcome: outcome({ repair: REPAIR }) });
  assert.match(fixed.comment, /one repair pass made the gates pass/);
  assert.deepEqual(fixed.add, []);
});

test('a repair pass that did not help escalates with its summary', () => {
  const r = report({
    mode: 'merge',
    outcome: mergeOutcome({
      push: false,
      escalate: true,
      causes: ['repair pass for check: the fixer could not repair it and needs a human'],
      repair: { ...REPAIR, decision: 'needs_human', edits: [] },
      gates: { install: 'success', check: 'failure', smoke: 'skipped' },
    }),
  });
  assert.deepEqual(r.add, ['needs-human']);
  assert.match(r.comment, /the repair pass needs a human/);
  assert.match(r.comment, /Repair: formatted/);
  assert.match(r.comment, /Why it stopped: repair pass for check/);
});

test('the round cost includes the repair pass', () => {
  const m = (cost) => ({
    total_cost_usd: cost,
    duration_ms: 60000,
    num_turns: 3,
    permission_denials: 0,
  });
  const line = metricsLine({ metrics: m(3), repair: { metrics: m(8) } });
  assert.match(line, /^Claude: \$3\.00, 1\.0 min/);
  assert.match(line, /Claude repair pass: \$8\.00/);
  assert.match(line, /Claude total for the round: \$11\.00\./);
  assert.doesNotMatch(metricsLine({ metrics: m(3) }), /total/);
  assert.equal(metricsLine(null), 'No Claude metrics.');
  assert.match(metricsLine(null, '3.5'), /first Claude run cost \$3\.50/);
  assert.equal(metricsLine(null, ''), 'No Claude metrics.');
  assert.match(metricsLine({ metrics: m(null), repair: { metrics: m(1) } }), /total.*n\/a/);
});
