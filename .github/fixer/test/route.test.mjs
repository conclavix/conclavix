import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../github.mjs';
import {
  aggregateWorkflows,
  checkTrust,
  classifyCi,
  countRounds,
  decideRoute,
  fetchPr,
  infraText,
  isConflicting,
  reviewStateOf,
  roundOf,
  triggerOf,
  waitForReviewRun,
} from '../route.mjs';

const config = loadConfig();
const REPO = 'conclavix/conclavix';
const HEAD = 'a'.repeat(40);

function pr(overrides = {}) {
  return {
    number: 7,
    state: 'open',
    draft: false,
    user: { login: config.trusted_logins[0] },
    head: { sha: HEAD, ref: 'feat/x', repo: { full_name: REPO } },
    labels: [],
    mergeable_state: 'clean',
    ...overrides,
  };
}

function route(overrides = {}) {
  return decideRoute({
    trigger: 'review',
    pr: pr(),
    runHeadSha: HEAD,
    review: 'failure',
    ci: 'success',
    rounds: 0,
    config,
    repository: REPO,
    ...overrides,
  });
}

const commit = (message) => ({ commit: { message } });

test('trust: open same-repo PRs of trusted authors only', () => {
  assert.equal(checkTrust(pr(), { repository: REPO, config }).ok, true);
  assert.equal(
    checkTrust(pr({ user: { login: config.bot_login } }), { repository: REPO, config }).ok,
    true,
  );
  assert.match(
    checkTrust(pr({ user: { login: 'mallory' } }), { repository: REPO, config }).reason,
    /not trusted/,
  );
  const fork = pr({ head: { sha: HEAD, ref: 'x', repo: { full_name: 'mallory/conclavix' } } });
  assert.match(checkTrust(fork, { repository: REPO, config }).reason, /fork/);
  assert.match(checkTrust(pr({ draft: true }), { repository: REPO, config }).reason, /draft/);
  assert.match(
    checkTrust(pr({ state: 'closed' }), { repository: REPO, config }).reason,
    /not open/,
  );
  assert.equal(
    checkTrust(pr({ head: { sha: HEAD, repo: null } }), { repository: REPO, config }).ok,
    false,
  );
});

test('rounds: counts the fixer commits at the tip and resets after a human commit', () => {
  const t = config.round_trailer;
  assert.equal(roundOf(`fix: x\n\n${t}: 2\nCo-Authored-By: a`, t), 2);
  assert.equal(roundOf('fix: x', t), null);
  assert.equal(countRounds([], t), 0);
  assert.equal(countRounds([commit('feat: a')], t), 0);
  assert.equal(
    countRounds([commit('feat: a'), commit(`fix: b\n\n${t}: 1`), commit(`fix: c\n\n${t}: 2`)], t),
    2,
  );
  const reset = [commit(`fix: b\n\n${t}: 1`), commit(`fix: c\n\n${t}: 2`), commit('fix: human')];
  assert.equal(countRounds(reset, t), 0);
  assert.equal(countRounds([commit(`fix: b\n\nsee ${t}: 3 inline`)], t), 0);
});

test('workflows: newest run per required workflow decides', () => {
  const run = (name, status, conclusion, at) => ({ name, status, conclusion, created_at: at });
  assert.equal(aggregateWorkflows([], ['CI']), 'pending');
  assert.equal(
    aggregateWorkflows([run('CI', 'completed', 'success', '2026-01-01T00:00:00Z')], ['CI']),
    'success',
  );
  const rerun = [
    run('CI', 'completed', 'failure', '2026-01-01T00:00:00Z'),
    run('CI', 'completed', 'success', '2026-01-02T00:00:00Z'),
  ];
  assert.equal(aggregateWorkflows(rerun, ['CI']), 'success');
  assert.equal(
    aggregateWorkflows([run('CI', 'in_progress', null, '2026-01-01T00:00:00Z')], ['CI']),
    'pending',
  );
  assert.equal(
    aggregateWorkflows([run('CI', 'completed', 'cancelled', '2026-01-01T00:00:00Z')], ['CI']),
    'failure',
  );
  assert.equal(
    aggregateWorkflows([run('Review', 'completed', 'success', '2026-01-01T00:00:00Z')], ['CI']),
    'pending',
  );
});

test('review state is read from the review context', () => {
  const combined = {
    statuses: [
      { context: 'ci/x', state: 'success' },
      { context: 'review', state: 'failure' },
    ],
  };
  assert.equal(reviewStateOf(combined, 'review'), 'failure');
  assert.equal(reviewStateOf({ statuses: [] }, 'review'), 'missing');
});

test('trigger: review runs and dispatch are review triggers, CI runs are not', () => {
  assert.equal(triggerOf('workflow_dispatch', '', config), 'review');
  assert.equal(triggerOf('workflow_run', 'Review', config), 'review');
  assert.equal(triggerOf('workflow_run', 'CI', config), 'ci');
});

test('route: failing review on a trusted PR starts the next round', () => {
  assert.deepEqual(route(), { mode: 'fix', reason: 'review failed', round: 1, dropReady: false });
  assert.equal(route({ rounds: 2 }).round, 3);
});

test('route: round limit, conflicts and labels escalate or skip', () => {
  assert.equal(route({ rounds: 3 }).mode, 'escalate');
  assert.equal(route({ rounds: 3 }).reason, 'round_limit');
  assert.equal(route({ pr: pr({ mergeable_state: 'dirty' }) }).mode, 'merge');
  assert.equal(route({ pr: pr({ labels: [{ name: 'no-autofix' }] }) }).mode, 'none');
  assert.equal(route({ pr: pr({ labels: [{ name: 'needs-human' }] }) }).mode, 'none');
  const both = route({ pr: pr({ labels: [{ name: 'needs-human' }, { name: 'merge-ready' }] }) });
  assert.equal(both.dropReady, true);
});

test('route: stale runs and untrusted PRs never fix, a red review waits for CI to finish', () => {
  assert.match(route({ runHeadSha: 'b'.repeat(40) }).reason, /older head/);
  assert.equal(route({ pr: pr({ user: { login: 'mallory' } }) }).mode, 'none');
  assert.equal(route({ pr: pr({ draft: true }) }).mode, 'none');
  assert.equal(route({ review: 'error' }).mode, 'none');
  assert.equal(route({ runHeadSha: null }).mode, 'fix');
  assert.equal(route({ ci: 'pending' }).mode, 'none');
  assert.equal(route({ trigger: 'ci' }).mode, 'fix');
});

test('route: green review and CI mark the PR merge-ready once', () => {
  assert.equal(route({ review: 'success', ci: 'success' }).mode, 'ready');
  assert.equal(route({ trigger: 'ci', review: 'success', ci: 'success' }).mode, 'ready');
  const labelled = pr({ labels: [{ name: 'merge-ready' }] });
  assert.equal(route({ review: 'success', ci: 'success', pr: labelled }).mode, 'none');
  const escalated = pr({ labels: [{ name: 'merge-ready' }, { name: 'needs-human' }] });
  assert.equal(route({ review: 'success', ci: 'success', pr: escalated }).mode, 'ready');
  assert.equal(route({ review: 'success', ci: 'pending' }).mode, 'none');
});

test('route: merge-ready is dropped when the review or CI turns red', () => {
  const labelled = pr({ labels: [{ name: 'merge-ready' }] });
  assert.equal(route({ pr: labelled, review: 'pending', trigger: 'ci' }).dropReady, true);
  assert.equal(
    route({ pr: labelled, review: 'success', ci: 'failure', trigger: 'ci' }).dropReady,
    true,
  );
  assert.equal(
    route({ pr: labelled, review: 'success', ci: 'pending', trigger: 'ci' }).dropReady,
    false,
  );
  assert.equal(route({ pr: labelled }).dropReady, true);
});

const CI_STEP = {
  workflow: 'CI',
  run_id: 1,
  run_url: 'https://example.test/runs/1',
  job: 'check',
  job_id: 11,
  step: 'Run pnpm format:check',
  number: 9,
};
const RED = { steps: [CI_STEP], infra: [] };
const INFRA = {
  steps: [],
  infra: [{ workflow: 'CI', job: 'check', step: 'Set up job', why: 'a setup step failed' }],
};

test('route: red CI with a green review starts a fix round', () => {
  const r = route({ review: 'success', ci: 'failure', ciFailures: RED, trigger: 'ci' });
  assert.deepEqual(r, { mode: 'fix', reason: 'CI failed', round: 1, dropReady: false });
  assert.equal(route({ review: 'success', ci: 'failure', ciFailures: RED }).mode, 'fix');
  assert.equal(route({ review: 'error', ci: 'failure', ciFailures: RED }).mode, 'fix');
});

test('route: red review and red CI are handled in one round', () => {
  const r = route({ review: 'failure', ci: 'failure', ciFailures: RED });
  assert.equal(r.mode, 'fix');
  assert.equal(r.reason, 'review failed, CI failed');
});

test('route: red CI waits for the review, and keeps every eligibility rule', () => {
  const red = { ci: 'failure', ciFailures: RED };
  assert.equal(route({ ...red, review: 'pending' }).mode, 'none');
  assert.equal(route({ ...red, review: 'missing' }).mode, 'none');
  assert.equal(route({ ...red, review: 'success', rounds: 3 }).reason, 'round_limit');
  for (const name of ['no-autofix', 'needs-human'])
    assert.equal(route({ ...red, review: 'success', pr: pr({ labels: [{ name }] }) }).mode, 'none');
  const others = [
    pr({ draft: true }),
    pr({ user: { login: 'mallory' } }),
    pr({ head: { sha: HEAD, ref: 'x', repo: { full_name: 'mallory/conclavix' } } }),
  ];
  for (const p of others) assert.equal(route({ ...red, review: 'success', pr: p }).mode, 'none');
  assert.equal(
    route({ ...red, review: 'success', pr: pr({ mergeable_state: 'dirty' }) }).mode,
    'merge',
  );
});

test('route: CI failing only for infrastructure escalates as ci_infra without a fix round', () => {
  const r = route({ review: 'success', ci: 'failure', ciFailures: INFRA });
  assert.equal(r.mode, 'escalate');
  assert.equal(r.reason, 'ci_infra');
  assert.match(r.detail, /CI \/ check \/ Set up job: a setup step failed/);
  const both = route({ review: 'failure', ci: 'failure', ciFailures: INFRA });
  assert.equal(both.mode, 'fix');
  assert.equal(both.reason, 'review failed');
  const labelled = pr({ labels: [{ name: 'needs-human' }] });
  assert.equal(
    route({ review: 'success', ci: 'failure', ciFailures: INFRA, pr: labelled }).mode,
    'none',
  );
});

test('route: merge-ready still needs a green review and green CI', () => {
  assert.equal(route({ review: 'success', ci: 'failure', ciFailures: RED }).mode, 'fix');
  assert.equal(route({ review: 'success', ci: 'success' }).mode, 'ready');
  const labelled = pr({ labels: [{ name: 'merge-ready' }] });
  assert.equal(
    route({ review: 'success', ci: 'failure', ciFailures: RED, pr: labelled }).dropReady,
    true,
  );
});

const job = (name, conclusion, steps) => ({ id: 11, name, conclusion, steps });
const step = (number, name, conclusion) => ({
  number,
  name,
  conclusion,
  started_at: '2026-10-04T14:38:19Z',
  completed_at: '2026-10-04T14:38:24Z',
});
const ciRun = (conclusion) => ({
  id: 1,
  name: 'CI',
  conclusion,
  html_url: 'https://example.test/runs/1',
});

test('classifyCi: failed project steps go to the fixer, setup and runner failures are infra', () => {
  const jobs = {
    1: [
      job('check', 'failure', [
        step(8, 'Run pnpm lint', 'success'),
        step(9, 'Run pnpm format:check', 'failure'),
        step(10, 'Run pnpm build', 'skipped'),
      ]),
      job('other', 'success', []),
    ],
  };
  const r = classifyCi([ciRun('failure')], jobs, config);
  assert.deepEqual(r.infra, []);
  assert.equal(r.steps.length, 1);
  assert.equal(r.steps[0].step, 'Run pnpm format:check');
  assert.equal(r.steps[0].number, 9);
  assert.equal(r.steps[0].job_id, 11);
  assert.equal(r.steps[0].started_at, '2026-10-04T14:38:19Z');
  const setup = classifyCi(
    [ciRun('failure')],
    { 1: [job('check', 'failure', [step(1, 'Set up job', 'failure')])] },
    config,
  );
  assert.equal(setup.steps.length, 0);
  assert.match(setup.infra[0].why, /setup step/);
  const mongo = classifyCi(
    [ciRun('failure')],
    { 1: [job('check', 'failure', [step(5, 'Start MongoDB (tmpfs)', 'failure')])] },
    config,
  );
  assert.equal(mongo.steps.length, 0);
});

test('classifyCi: timeouts, cancellations and lost runners are infra', () => {
  assert.match(classifyCi([ciRun('timed_out')], {}, config).infra[0].why, /timed_out/);
  assert.match(classifyCi([ciRun('cancelled')], {}, config).infra[0].why, /cancelled/);
  assert.match(
    classifyCi([ciRun('failure')], { 1: [] }, config).infra[0].why,
    /without a failed job/,
  );
  const timedOut = { 1: [job('check', 'timed_out', [step(13, 'Run pnpm test', 'cancelled')])] };
  assert.match(classifyCi([ciRun('failure')], timedOut, config).infra[0].why, /timed_out/);
  const lost = { 1: [job('check', 'failure', [step(13, 'Run pnpm test', 'success')])] };
  assert.match(classifyCi([ciRun('failure')], lost, config).infra[0].why, /without a failed step/);
});

test('classifyCi: names are sanitised and the number of steps is capped', () => {
  const many = Array.from({ length: 9 }, (_, i) =>
    step(i + 1, `Run x${i}\u001b[31m\n::set`, 'failure'),
  );
  const r = classifyCi([ciRun('failure')], { 1: [job('check', 'failure', many)] }, config);
  assert.equal(r.steps.length, config.ci.max_steps);
  assert.ok([...r.steps[0].step].every((ch) => ch.charCodeAt(0) >= 32));
  assert.equal(infraText([{ workflow: 'CI', job: '', step: '', why: 'w' }]), 'CI: w');
});

test('route: a red review whose Review run has not completed yet waits instead of escalating', () => {
  // CI completes after the Review publish job set the red status but before the Review run itself
  // completed: there is no completed Review run, so no findings artifact, for this head yet.
  const fix = route({ trigger: 'ci', review: 'failure', ci: 'failure', ciFailures: RED });
  assert.equal(fix.mode, 'fix');
  const waiting = waitForReviewRun(fix, { review: 'failure', reviewRun: '' });
  assert.equal(waiting.mode, 'none');
  assert.match(waiting.reason, /waiting for the Review run/);
  const labelled = route({
    review: 'failure',
    ci: 'failure',
    ciFailures: RED,
    pr: pr({ labels: [{ name: 'merge-ready' }] }),
  });
  assert.equal(waitForReviewRun(labelled, { review: 'failure', reviewRun: '' }).dropReady, true);
  assert.equal(waitForReviewRun(fix, { review: 'failure', reviewRun: '42' }), fix);
  const ciOnly = route({ review: 'success', ci: 'failure', ciFailures: RED });
  assert.equal(waitForReviewRun(ciOnly, { review: 'success', reviewRun: '' }), ciOnly);
  const escalated = route({ rounds: 3 });
  assert.equal(waitForReviewRun(escalated, { review: 'failure', reviewRun: '' }), escalated);
});

test('route: a conflicting PR is merged with its base first, whatever review and CI say', () => {
  const dirty = pr({ mergeable: false, mergeable_state: 'dirty' });
  assert.deepEqual(route({ pr: dirty }), {
    mode: 'merge',
    reason: 'merge conflict with the base branch',
    round: 1,
    dropReady: false,
  });
  for (const state of [
    { review: 'success', ci: 'success' },
    { review: 'missing', ci: 'pending' },
    { review: 'failure', ci: 'failure', ciFailures: RED },
  ])
    assert.equal(route({ ...state, pr: dirty }).mode, 'merge');
  assert.equal(route({ pr: pr({ mergeable: false }) }).mode, 'merge');
  assert.equal(route({ pr: dirty, rounds: 2 }).round, 3);
  const ready = route({ pr: pr({ mergeable_state: 'dirty', labels: [{ name: 'merge-ready' }] }) });
  assert.equal(ready.mode, 'merge');
  assert.equal(ready.dropReady, true);
});

test('route: conflicting PRs keep every eligibility rule and the round limit', () => {
  const dirty = { mergeable: false, mergeable_state: 'dirty' };
  for (const name of ['no-autofix', 'needs-human'])
    assert.equal(route({ pr: pr({ ...dirty, labels: [{ name }] }) }).mode, 'none');
  assert.equal(route({ pr: pr({ ...dirty, draft: true }) }).mode, 'none');
  assert.equal(route({ pr: pr({ ...dirty, user: { login: 'mallory' } }) }).mode, 'none');
  const fork = { sha: HEAD, ref: 'x', repo: { full_name: 'mallory/conclavix' } };
  assert.equal(route({ pr: pr({ ...dirty, head: fork }) }).mode, 'none');
  const limit = route({ pr: pr(dirty), rounds: 3 });
  assert.equal(limit.mode, 'escalate');
  assert.equal(limit.reason, 'round_limit');
  assert.match(limit.detail, /merge conflicts/);
});

test('route: a conflict scan run does nothing for a PR that no longer conflicts', () => {
  assert.equal(route({ conflictsOnly: true }).mode, 'none');
  assert.match(route({ conflictsOnly: true }).reason, /no merge conflict/);
  assert.equal(route({ conflictsOnly: true, review: 'success', ci: 'success' }).mode, 'none');
  assert.equal(route({ conflictsOnly: true, pr: pr({ mergeable: false }) }).mode, 'merge');
  assert.equal(isConflicting(pr({ mergeable: null, mergeable_state: 'unknown' })), false);
});

test('route: the round limit names what is still red', () => {
  assert.equal(route({ rounds: 3 }).detail, 'The review still has blocking findings.');
  const ci = route({ rounds: 3, review: 'success', ci: 'failure', ciFailures: RED });
  assert.equal(ci.detail, 'CI is still red.');
  const both = route({ rounds: 3, ci: 'failure', ciFailures: RED });
  assert.equal(both.detail, 'The review still has blocking findings.\nCI is still red.');
});

test('fetchPr asks again while GitHub has not computed mergeable yet, bounded', async () => {
  const answers = [{ mergeable: null }, { mergeable: null }, { mergeable: false }];
  const calls = [];
  const request = async (method, path) => {
    calls.push(path);
    return { state: 'open', ...answers[Math.min(calls.length - 1, answers.length - 1)] };
  };
  const got = await fetchPr(request, 29, config, async () => {});
  assert.equal(got.mergeable, false);
  assert.equal(calls.length, 3);
  const never = async () => ({ state: 'open', mergeable: null });
  let count = 0;
  await fetchPr(
    async (...a) => {
      count += 1;
      return never(...a);
    },
    29,
    config,
    async () => {},
  );
  assert.equal(count, config.merge.mergeable_polls + 1);
});
