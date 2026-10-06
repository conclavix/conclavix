import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { env, loadConfig, setOutput } from './github.mjs';
import { checkResolution, isAncestor, verifyMergeCommit } from './merge.mjs';
import { checkChanges, collectDiff, git } from './policy.mjs';
import { parsePathList } from './repair.mjs';
import { roundOf } from './route.mjs';
import { selectFindings, validateDocument } from './select.mjs';

const SHA = /^[0-9a-f]{40}$/;

/** @returns {string[]} problems that forbid pushing the fixer commit */
export function verifyCommit({ sha, parents, message, head, round, trailer, branch }) {
  const problems = [];
  if (!SHA.test(sha)) problems.push(`invalid commit ${sha}`);
  if (parents.length !== 1 || parents[0] !== head)
    problems.push(`the commit must have exactly one parent, the PR head ${head}`);
  if (roundOf(message, trailer) !== round)
    problems.push(`the commit is not marked as round ${round}`);
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith('-') || branch.includes('..'))
    problems.push(`unexpected branch name ${branch}`);
  return problems;
}

/**
 * Blocking findings of the review that this round worked on. A round that only fixes CI has no
 * review result, and failed CI steps never unlock guarded paths, so no file is allowed extra.
 */
function reviewFindings({ pr, head }) {
  if (!process.env.REVIEW_RUN) return [];
  const doc = JSON.parse(readFileSync(env('FINDINGS_FILE'), 'utf8'));
  validateDocument(doc, { pr, headSha: head });
  return selectFindings(doc).fixable;
}

/**
 * Merge mode: exactly one merge commit whose parents are the reviewed head and the base tip the
 * route job read, resolving only what `git merge-tree` reports as conflicted (plus explained small
 * edits elsewhere), never in protected files. A clean merge must be exactly git's merge. The merged
 * base commit must still be on the base branch (`baseTip` is its current tip): when the branch moved
 * on meanwhile the merge is still pushed, so the round counts and the loop stays bounded; a scan
 * after that push merges the newer tip if it conflicts again.
 * @returns {string[]} problems that forbid pushing
 */
export function verifyMerge({
  cwd,
  sha,
  parents,
  message,
  head,
  base,
  baseTip,
  round,
  branch,
  config,
  repairPaths = [],
}) {
  const problems = verifyMergeCommit({
    sha,
    parents,
    message,
    head,
    base,
    round,
    trailer: config.round_trailer,
    branch,
  });
  if (problems.length > 0) return problems;
  if (!isAncestor(cwd, base, baseTip))
    problems.push(`the merged base ${base} is not on the base branch (tip ${baseTip})`);
  const result = checkResolution({ cwd, head, base, tree: sha, config, repairPaths });
  problems.push(...result.violations);
  if (result.clean && result.extra.some((p) => !repairPaths.includes(p)))
    problems.push('the base merges without conflicts, but the commit differs from that merge');
  return problems;
}

/**
 * Repair paths from the fix job's `repair_paths` output (a JSON list, at most 50 relative paths).
 * @returns {string[]}
 */
export function parseRepairPaths(text) {
  try {
    return parsePathList(text, 50);
  } catch {
    throw new Error('the fix job reported an invalid list of repair paths');
  }
}

/** @returns {string} the current tip of the base branch in the push job's full checkout */
function baseTipOf(cwd, baseRef) {
  git(['check-ref-format', '--branch', baseRef], cwd);
  return git(['rev-parse', `refs/remotes/origin/${baseRef}^{commit}`], cwd).trim();
}

function main() {
  const config = loadConfig();
  const cwd = env('WORK_DIR');
  const head = env('HEAD_SHA');
  const round = Number(env('ROUND'));
  const branch = env('BRANCH');
  git(['bundle', 'verify', '-q', env('BUNDLE')], cwd);
  git(['fetch', '-q', '--no-tags', env('BUNDLE'), '+fixer-out:refs/fixer/out'], cwd);
  const sha = git(['rev-parse', 'refs/fixer/out'], cwd).trim();
  const parents = git(['rev-list', '--parents', '-n', '1', sha], cwd).trim().split(' ').slice(1);
  const message = git(['log', '-1', '--format=%B', sha], cwd);
  git(['check-ref-format', '--branch', branch], cwd);
  if (process.env.MODE === 'merge') {
    const base = env('BASE_SHA');
    const baseTip = baseTipOf(cwd, env('BASE_REF'));
    const problems = verifyMerge({
      cwd,
      sha,
      parents,
      message,
      head,
      base,
      baseTip,
      round,
      branch,
      config,
      repairPaths: parseRepairPaths(process.env.REPAIR_PATHS),
    });
    if (problems.length > 0) throw new Error(`refusing to push:\n- ${problems.join('\n- ')}`);
    setOutput('sha', sha);
    process.stdout.write(`verify: merge ${sha} of ${head} and ${base} (tip ${baseTip}) is ok\n`);
    return;
  }
  const problems = verifyCommit({
    sha,
    parents,
    message,
    head,
    round,
    trailer: config.round_trailer,
    branch,
  });
  const fixable = reviewFindings({ pr: env('PR_NUMBER'), head });
  const policy = checkChanges(collectDiff(head, sha, cwd), fixable, config);
  problems.push(...policy.violations);
  if (problems.length > 0) throw new Error(`refusing to push:\n- ${problems.join('\n- ')}`);
  setOutput('sha', sha);
  process.stdout.write(`verify: ${sha} on ${head} is ok\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`verify: ${error.message}\n`);
    process.exit(1);
  }
}
