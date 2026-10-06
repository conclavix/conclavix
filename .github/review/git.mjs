import { execFileSync } from 'node:child_process';

export const SHA = /^[0-9a-f]{40}$/;

export function git(args, options = {}) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trimEnd();
}

function tryGit(run, args) {
  try {
    return run(args);
  } catch {
    return null;
  }
}

/**
 * Finds the tip of the base branch the pull request was compared against.
 * - pull_request event: the base sha from the event.
 * - merged PR with a true merge commit whose second parent is the PR head: its first parent.
 * - open PR: the current remote base branch.
 * - otherwise: the base sha GitHub recorded for the PR.
 */
export function resolveBaseTip(pr, { event, run = git }) {
  if (event === 'pull_request') return { sha: pr.base.sha, how: 'event base sha' };
  if (pr.merged && pr.merge_commit_sha) {
    const parents = tryGit(run, ['rev-list', '--parents', '-n', '1', pr.merge_commit_sha]);
    const list = parents ? parents.split(' ') : [];
    if (list.length === 3 && list[2] === pr.head.sha) {
      return { sha: list[1], how: 'first parent of the merge commit' };
    }
  }
  if (pr.state === 'open') {
    const remote = tryGit(run, [
      'rev-parse',
      '--verify',
      `refs/remotes/origin/${pr.base.ref}^{commit}`,
    ]);
    if (remote) return { sha: remote, how: `origin/${pr.base.ref}` };
  }
  return { sha: pr.base.sha, how: 'recorded base sha' };
}

export function mergeBase(baseTip, head, run = git) {
  const base = run(['merge-base', baseTip, head]);
  if (!SHA.test(base)) throw new Error(`no merge base between ${baseTip} and ${head}`);
  if (base === head)
    throw new Error(`head ${head} is already contained in the base; the diff is empty`);
  return base;
}
