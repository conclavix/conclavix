import { fileURLToPath } from 'node:url';
import { clientFromEnv, env, loadConfig, paginate, plain, setOutput, summary } from './github.mjs';

const SHA = /^[0-9a-f]{40}$/;

/** @returns {object} ok is true for open, non-draft, same-repository PRs of trusted authors */
export function checkTrust(pr, { repository, config }) {
  if (!pr || pr.state !== 'open') return { ok: false, reason: 'pull request is not open' };
  if (pr.head?.repo?.full_name !== repository)
    return { ok: false, reason: 'pull request comes from a fork' };
  if (pr.draft) return { ok: false, reason: 'pull request is a draft' };
  const login = pr.user?.login ?? '';
  if (!config.trusted_logins.includes(login))
    return { ok: false, reason: `author ${login || '(unknown)'} is not trusted` };
  return { ok: true, reason: 'trusted' };
}

export function roundOf(message, trailer) {
  const match = new RegExp(`^${trailer}:\\s*(\\d+)\\s*$`, 'm').exec(String(message ?? ''));
  return match ? Number(match[1]) : null;
}

/** @returns {number} highest round trailer among the consecutive fixer commits at the PR tip */
export function countRounds(commits, trailer) {
  let rounds = 0;
  for (const commit of [...commits].reverse()) {
    const round = roundOf(commit.commit?.message, trailer);
    if (round === null) break;
    rounds = Math.max(rounds, round);
  }
  return rounds;
}

/** @returns {object[]} the newest run of each named workflow that has one */
export function newestRuns(runs, names) {
  return names
    .map(
      (name) =>
        runs
          .filter((r) => r.name === name)
          .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0],
    )
    .filter(Boolean);
}

/** @returns {'success'|'failure'|'pending'} state of the newest run of each named workflow */
export function aggregateWorkflows(runs, names) {
  const newest = newestRuns(runs, names);
  let state = newest.length < names.length ? 'pending' : 'success';
  for (const run of newest) {
    if (run.status !== 'completed') {
      if (state === 'success') state = 'pending';
    } else if (run.conclusion !== 'success') state = 'failure';
  }
  return state;
}

const STEP_OK = new Set(['success', 'skipped', 'neutral']);

/**
 * Splits the failures of the newest, completed, red CI runs into failed steps the fixer may work on
 * and infrastructure failures (setup steps, timeouts, cancellations, lost runners) that go to a
 * human. Names come from the PR's own workflow file and are only ever used as data.
 * @returns {{steps: object[], infra: object[]}}
 */
export function classifyCi(runs, jobsByRun, config) {
  const infraStep = config.ci.infra_steps.map((p) => new RegExp(p));
  const steps = [];
  const infra = [];
  for (const run of runs) {
    const workflow = plain(run.name, 100);
    const base = { workflow, run_id: run.id, run_url: run.html_url };
    if (run.conclusion !== 'failure') {
      infra.push({
        ...base,
        job: '',
        step: '',
        why: `the run ended as ${plain(run.conclusion, 40)}`,
      });
      continue;
    }
    const failedJobs = (jobsByRun[run.id] ?? []).filter((j) => !STEP_OK.has(j.conclusion));
    if (failedJobs.length === 0)
      infra.push({ ...base, job: '', step: '', why: 'the run failed without a failed job' });
    for (const job of failedJobs) {
      const at = { ...base, job: plain(job.name, 100), job_id: job.id };
      if (job.conclusion !== 'failure') {
        infra.push({ ...at, step: '', why: `the job ended as ${plain(job.conclusion, 40)}` });
        continue;
      }
      const failed = (job.steps ?? []).filter((st) => st.conclusion === 'failure');
      if (failed.length === 0)
        infra.push({ ...at, step: '', why: 'the job failed without a failed step' });
      for (const st of failed) {
        const step = { ...at, step: plain(st.name, 200), number: st.number };
        if (infraStep.some((p) => p.test(st.name ?? '')))
          infra.push({ ...step, why: 'a setup step failed, not a project check' });
        else steps.push({ ...step, started_at: st.started_at, completed_at: st.completed_at });
      }
    }
  }
  return { steps: steps.slice(0, config.ci.max_steps), infra };
}

/** @returns {string} one line per infrastructure failure for the escalation comment */
export function infraText(infra) {
  return infra
    .map((i) => `${[i.workflow, i.job, i.step].filter(Boolean).join(' / ')}: ${i.why}`)
    .join('\n');
}

export function reviewStateOf(combined, context) {
  const status = (combined?.statuses ?? []).find((s) => s.context === context);
  return status ? status.state : 'missing';
}

function labelsOf(pr) {
  return (pr.labels ?? []).map((l) => l.name);
}

function none(reason, extra = {}) {
  return { mode: 'none', reason, round: 0, dropReady: false, ...extra };
}

const REVIEW_DONE = new Set(['success', 'failure', 'error']);

/** @returns {boolean} the review and CI have both finished and at least one of them is red */
function settledRed(review, ci) {
  const red = review === 'failure' || ci === 'failure';
  return red && REVIEW_DONE.has(review) && ci !== 'pending';
}

function decideFailure({ pr, rounds, config, review, ci, ciFailures }) {
  const reviewRed = review === 'failure';
  const ciCode = ci === 'failure' && ciFailures.steps.length > 0;
  const labels = labelsOf(pr);
  const dropReady = labels.includes(config.labels.ready);
  const skip = config.labels.skip.find((l) => labels.includes(l));
  if (skip) return none(`label ${skip} is set`, { dropReady });
  if (!reviewRed && !ciCode)
    return {
      mode: 'escalate',
      reason: 'ci_infra',
      round: rounds,
      dropReady,
      detail: infraText(ciFailures.infra),
    };
  if (rounds >= config.max_rounds) {
    const left = [
      reviewRed && 'The review still has blocking findings.',
      ci === 'failure' && 'CI is still red.',
    ].filter(Boolean);
    return {
      mode: 'escalate',
      reason: 'round_limit',
      round: rounds,
      dropReady,
      detail: left.join('\n'),
    };
  }
  const what = [reviewRed && 'review failed', ciCode && 'CI failed'].filter(Boolean).join(', ');
  return { mode: 'fix', reason: what, round: rounds + 1, dropReady };
}

/** @returns {boolean} GitHub reports a merge conflict between the PR head and its base */
export function isConflicting(pr) {
  return pr.mergeable === false || pr.mergeable_state === 'dirty';
}

/**
 * A conflicting PR is merged with its base before anything else: GitHub does not run pull_request
 * workflows for it, so review and CI cannot finish until the conflict is gone.
 */
function decideConflict({ pr, rounds, config }) {
  const labels = labelsOf(pr);
  const dropReady = labels.includes(config.labels.ready);
  const skip = config.labels.skip.find((l) => labels.includes(l));
  if (skip) return none(`label ${skip} is set`, { dropReady });
  if (rounds >= config.max_rounds)
    return {
      mode: 'escalate',
      reason: 'round_limit',
      round: rounds,
      dropReady,
      detail: 'The branch still has merge conflicts with its base.',
    };
  return {
    mode: 'merge',
    reason: 'merge conflict with the base branch',
    round: rounds + 1,
    dropReady,
  };
}

/**
 * A fix round starts once the review and every required workflow have finished on the head and at
 * least one of them is red, so one round sees all failures of a head; the trigger does not matter.
 * @returns {object} mode is fix, escalate, ready or none; round is the round to run or the last one
 */
export function decideRoute({
  pr,
  runHeadSha,
  review,
  ci,
  ciFailures = { steps: [], infra: [] },
  rounds,
  config,
  repository,
  conflictsOnly = false,
}) {
  const trust = checkTrust(pr, { repository, config });
  if (!trust.ok) return none(trust.reason);
  if (runHeadSha && runHeadSha !== pr.head.sha) return none('the run is for an older head');
  if (isConflicting(pr)) return decideConflict({ pr, rounds, config });
  if (conflictsOnly) return none('the pull request has no merge conflict');
  const labels = labelsOf(pr);
  const hasReady = labels.includes(config.labels.ready);
  if (review === 'success' && ci === 'success') {
    if (hasReady && !labels.includes(config.labels.escalated)) return none('already merge-ready');
    return { mode: 'ready', reason: 'review and CI are green', round: rounds, dropReady: false };
  }
  const dropReady = hasReady && (review !== 'success' || ci === 'failure');
  if (settledRed(review, ci)) return decideFailure({ pr, rounds, config, review, ci, ciFailures });
  return none(`review is ${review}, CI is ${ci}`, { dropReady });
}

/**
 * The Review workflow sets the red `review` status in its publish job, before the run itself has
 * completed. A CI completion in that window finds no completed Review run for the head (and so no
 * findings artifact): wait for the Review run's own completion, which routes again, instead of
 * escalating.
 * @returns {object} the route result, or `none` while the review artifact is not available yet
 */
export function waitForReviewRun(result, { review, reviewRun }) {
  if (result.mode !== 'fix' || review !== 'failure' || reviewRun) return result;
  return none('waiting for the Review run of this head to complete', {
    dropReady: result.dropReady,
  });
}

async function findReviewRun(request, headSha, config) {
  const runs = await paginate(
    request,
    `/actions/runs?head_sha=${headSha}&event=pull_request&status=completed`,
    'workflow_runs',
    3,
  );
  const newest = runs
    .filter((r) => r.name === config.review_workflow)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  return newest ? String(newest.id) : '';
}

function pickPrNumber() {
  const manual = process.env.INPUT_PR_NUMBER ?? '';
  if (manual !== '') {
    if (!/^\d+$/.test(manual)) throw new Error(`invalid pr_number: ${manual}`);
    return Number(manual);
  }
  const list = JSON.parse(process.env.RUN_PULL_REQUESTS || '[]');
  const headSha = process.env.RUN_HEAD_SHA ?? '';
  const match = list.find((p) => p?.head?.sha === headSha) ?? list[0];
  return match ? Number(match.number) : null;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GitHub computes `mergeable` in the background and returns null until it is known; ask again a
 * bounded number of times. A PR whose state stays unknown is treated as not conflicting.
 * @returns {Promise<object>} the pull request
 */
export async function fetchPr(request, number, config, sleep = delay) {
  let pr = await request('GET', `/pulls/${number}`);
  for (let i = 0; i < config.merge.mergeable_polls && pr.state === 'open'; i += 1) {
    if (pr.mergeable !== null && pr.mergeable !== undefined) break;
    await sleep(config.merge.mergeable_poll_ms);
    pr = await request('GET', `/pulls/${number}`);
  }
  return pr;
}

/** @returns {Promise<string>} the current tip of the PR's base branch */
async function baseTip(request, ref) {
  if (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.includes('..'))
    throw new Error(`unexpected base branch ${ref}`);
  const data = await request('GET', `/git/ref/heads/${ref}`);
  const sha = data?.object?.sha ?? '';
  if (!SHA.test(sha)) throw new Error(`unexpected base sha ${sha}`);
  return sha;
}

async function gather(request, number, config) {
  const pr = await fetchPr(request, number, config);
  const sha = pr.head.sha;
  if (!SHA.test(sha)) throw new Error(`unexpected head sha ${sha}`);
  const combined = await request('GET', `/commits/${sha}/status`);
  const runs = await paginate(
    request,
    `/actions/runs?head_sha=${sha}&event=pull_request`,
    'workflow_runs',
    3,
  );
  const commits = await paginate(request, `/pulls/${number}/commits`, null, 3);
  const ci = aggregateWorkflows(runs, config.required_workflows);
  const red = newestRuns(runs, config.required_workflows).filter(
    (r) => r.status === 'completed' && r.conclusion !== 'success',
  );
  const jobsByRun = {};
  if (ci === 'failure') {
    for (const run of red)
      jobsByRun[run.id] = await paginate(
        request,
        `/actions/runs/${run.id}/jobs?filter=latest`,
        'jobs',
        3,
      );
  }
  return {
    pr,
    review: reviewStateOf(combined, config.review_context),
    ci,
    ciFailures: ci === 'failure' ? classifyCi(red, jobsByRun, config) : { steps: [], infra: [] },
    rounds: countRounds(commits, config.round_trailer),
  };
}

function write(result, extra) {
  const values = {
    ...extra,
    mode: result.mode,
    reason: result.reason,
    detail: result.detail ?? '',
  };
  values.round = String(result.round);
  values.drop_ready = String(result.dropReady);
  for (const [name, value] of Object.entries(values)) setOutput(name, value);
  summary(
    `## Fixer routing\n\n- PR: #${extra.pr || '-'}\n- Mode: \`${result.mode}\`\n- Why: ${result.reason}\n- Round: ${result.round}\n`,
  );
  process.stdout.write(`route: #${extra.pr || '-'} ${result.mode} (${result.reason})\n`);
}

export function triggerOf(eventName, runName, config) {
  if (eventName === 'workflow_dispatch') return 'review';
  return runName === config.review_workflow ? 'review' : 'ci';
}

async function reviewRunFor(request, trigger, headSha, config) {
  const own = trigger === 'review' && process.env.RUN_NAME === config.review_workflow;
  if (own && /^\d+$/.test(process.env.RUN_ID ?? '')) return process.env.RUN_ID;
  return findReviewRun(request, headSha, config);
}

async function main() {
  const config = loadConfig();
  const repository = env('GITHUB_REPOSITORY');
  const trigger = triggerOf(env('GITHUB_EVENT_NAME'), process.env.RUN_NAME ?? '', config);
  const number = pickPrNumber();
  if (number === null) return write(none('no pull request for this run'), { pr: '' });
  const request = clientFromEnv();
  const state = await gather(request, number, config);
  const runHeadSha = process.env.RUN_HEAD_SHA || null;
  const conflictsOnly = process.env.INPUT_CONFLICTS_ONLY === 'true';
  const result = decideRoute({ runHeadSha, repository, config, conflictsOnly, ...state });
  let reviewRun = '';
  if (result.mode === 'fix' && state.review === 'failure')
    reviewRun = await reviewRunFor(request, trigger, state.pr.head.sha, config);
  const final = waitForReviewRun(result, { review: state.review, reviewRun });
  const ciSteps = final.mode === 'fix' ? state.ciFailures : { steps: [], infra: [] };
  return write(final, {
    pr: String(number),
    head_sha: state.pr.head.sha,
    head_ref: state.pr.head.ref,
    base_ref: final.mode === 'merge' ? state.pr.base.ref : '',
    base_sha: final.mode === 'merge' ? await baseTip(request, state.pr.base.ref) : '',
    review_run: reviewRun,
    review: state.review,
    ci: state.ci,
    ci_failures: JSON.stringify(ciSteps),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`route: ${error.message}\n`);
    process.exit(1);
  });
}
