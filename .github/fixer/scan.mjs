import { fileURLToPath } from 'node:url';
import { clientFromEnv, env, loadConfig, paginate, summary } from './github.mjs';
import { checkTrust, isConflicting } from './route.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Open PRs the fixer may work on at all (trusted, same repository, not a draft, no skip label),
 * oldest first. Pure, so it is tested without the API. There is no cap here: the conflict filter
 * must see every eligible PR.
 * @returns {object[]}
 */
export function eligible(pulls, { repository, config }) {
  return pulls
    .filter((pr) => checkTrust(pr, { repository, config }).ok)
    .filter((pr) => !(pr.labels ?? []).some((l) => config.labels.skip.includes(l.name)))
    .sort((a, b) => a.number - b.number);
}

/** @returns {number[]} the conflicting PRs to dispatch a fixer run for, at most `max_dispatch` */
export function pickConflicting(details, config) {
  return details
    .filter(isConflicting)
    .map((pr) => pr.number)
    .slice(0, config.merge.max_dispatch);
}

/**
 * Reads every PR once (which also makes GitHub start computing `mergeable`), then re-reads only the
 * ones still unknown, a bounded number of times with one wait per pass. A PR that cannot be read is
 * reported and skipped; it never stops the scan for the others.
 * @returns {Promise<{details: object[], failed: number[]}>}
 */
export async function fetchAll(request, numbers, config, sleep = delay) {
  const byNumber = new Map();
  const failed = new Set();
  const read = async (number) => {
    try {
      byNumber.set(number, await request('GET', `/pulls/${number}`));
      failed.delete(number);
    } catch (error) {
      failed.add(number);
      process.stderr.write(`scan: #${number} could not be read: ${error.message}\n`);
    }
  };
  for (const number of numbers) await read(number);
  for (let i = 0; i < config.merge.mergeable_polls; i += 1) {
    const unknown = numbers.filter(
      (n) => failed.has(n) || [null, undefined].includes(byNumber.get(n)?.mergeable),
    );
    if (unknown.length === 0) break;
    await sleep(config.merge.mergeable_poll_ms);
    for (const number of unknown) await read(number);
  }
  const details = numbers.map((n) => byNumber.get(n)).filter(Boolean);
  return { details, failed: [...failed] };
}

/** @returns {Promise<number[]>} the PRs whose dispatch failed; one failure never stops the others */
export async function dispatchAll(request, numbers, { workflow, ref }) {
  const failed = [];
  for (const number of numbers) {
    try {
      await request('POST', `/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
        ref,
        inputs: { pr_number: String(number), conflicts_only: 'true' },
      });
    } catch (error) {
      failed.push(number);
      process.stderr.write(`scan: dispatch for #${number} failed: ${error.message}\n`);
    }
  }
  return failed;
}

/**
 * After a push to the default branch (or on the schedule) finds the open PRs that now conflict with
 * their base and starts one fixer run per PR with `workflow_dispatch`. Each of those runs has the
 * PR's own concurrency group, so a scan never runs two rounds on one PR at the same time. The scan
 * itself reads PR metadata only and never checks out PR code. Failures are reported per PR and
 * fail the job at the end, after every other PR was handled.
 */
async function main() {
  const config = loadConfig();
  const repository = env('GITHUB_REPOSITORY');
  const ref = env('DEFAULT_BRANCH');
  const workflow = env('WORKFLOW_FILE');
  const request = clientFromEnv();
  const pulls = await paginate(request, '/pulls?state=open&sort=created&direction=asc', null, 3);
  const candidates = eligible(pulls, { repository, config }).map((pr) => pr.number);
  const { details, failed: unread } = await fetchAll(request, candidates, config);
  const picked = pickConflicting(details, config);
  const undispatched = await dispatchAll(request, picked, { workflow, ref });
  const started = picked.filter((n) => !undispatched.includes(n));
  const list = (numbers) => numbers.map((n) => `#${n}`).join(', ') || 'none';
  summary(
    `## Fixer conflict scan\n\n${candidates.length} eligible open PR(s) checked. Fixer runs started for: ${list(started)}. Could not read: ${list(unread)}. Dispatch failed: ${list(undispatched)}.\n`,
  );
  process.stdout.write(`scan: ${candidates.length} checked, dispatched ${list(started)}\n`);
  if (unread.length > 0 || undispatched.length > 0) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`scan: ${error.message}\n`);
    process.exit(1);
  });
}
