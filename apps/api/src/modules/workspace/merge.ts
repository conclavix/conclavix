import { DEFAULT_BRANCH, issueBranchName } from '@conclavix/core';
import { AppError, conflict, notFound } from '../../errors.js';
import { GitError } from './git.js';
import { RepoReader } from './reader.js';
import {
  DEFAULT_AGENT_EMAIL_DOMAIN,
  cleanMessage,
  oneLine,
  safeIdent,
  type CommitIdentity,
} from './identity.js';
import { NO_REF, OBJECT_ID, type ResolvedRef } from './repo-base.js';

export {
  DEFAULT_AGENT_EMAIL_DOMAIN,
  MAX_MERGE_MESSAGE,
  agentIdentity,
  cleanMessage,
  oneLine,
  safeIdent,
  type CommitIdentity,
} from './identity.js';

/** Source branches one merge call may name. */
export const MAX_MERGE_SOURCES = 10;
/** Conflicting files listed in one conflict report. */
export const MAX_CONFLICT_FILES = 100;

export interface ConflictFile {
  path: string;
  /** Conflict types as git names them: `contents`, `modify/delete`, `rename/delete`, ... */
  kinds: string[];
}

export interface TreeMerge {
  tree: string;
  /** Empty when the merge is clean. */
  conflicts: ConflictFile[];
  /** Conflicting files past MAX_CONFLICT_FILES. */
  moreConflicts: number;
}

export interface MergeStep {
  source: string;
  sha: string;
  /** The merge commit, or null when the target already contained the source. */
  commit: string | null;
}

export interface BranchMerge {
  target: string;
  status: 'merged' | 'up_to_date';
  /** True when the target branch did not exist and was created from `startedFrom`. */
  created: boolean;
  /** Where the merges started: the existing target, or the base the new target was cut from. */
  startedFrom: ResolvedRef;
  before: string | null;
  after: string;
  merges: MergeStep[];
}

export interface BranchPromotion {
  branch: string;
  source: string;
  status: 'fast_forwarded' | 'up_to_date';
  before: string;
  after: string;
  /** Commits the branch gained. */
  commits: number;
}

export interface SourceStatus {
  source: string;
  sha: string;
  /** The target (or, without a target, its base) already contains the source. */
  contained: boolean;
  /** Conflicts a merge onto the target would hit right now; empty when it would be clean. */
  conflicts: ConflictFile[];
  moreConflicts: number;
}

export interface MergeStatus {
  target: string;
  exists: boolean;
  tip: string | null;
  /** Commits of the target missing on main, and of main missing on the target. */
  ahead: number;
  behind: number;
  /** Main can be fast-forwarded to the target. */
  canFastForwardMain: boolean;
  sources: SourceStatus[];
}

/**
 * Parse `git merge-tree --write-tree -z --name-only`: the tree id, the conflicted paths up to an
 * empty field, then messages as `<count> <path>... <type> <text>`. Types `CONFLICT (<kind>)` give
 * each conflicted path its kinds.
 */
export function parseMergeTree(output: string): TreeMerge {
  const fields = output.split('\0');
  const tree = fields[0] ?? '';
  if (!OBJECT_ID.test(tree)) throw new Error('git merge-tree returned no tree id');
  const kinds = new Map<string, Set<string>>();
  let index = 1;
  for (; index < fields.length && fields[index] !== ''; index += 1) {
    const path = fields[index] as string;
    if (!kinds.has(path)) kinds.set(path, new Set());
  }
  index += 1;
  while (index < fields.length) {
    const count = Number(fields[index]);
    if (!Number.isInteger(count) || count < 0) break;
    const paths = fields.slice(index + 1, index + 1 + count);
    const type = fields[index + 1 + count] ?? '';
    index += count + 3;
    const kind = /^CONFLICT \(([^)]+)\)/.exec(type)?.[1];
    if (!kind) continue;
    for (const path of paths) kinds.get(path)?.add(kind);
  }
  const all = [...kinds].map(([path, set]) => ({ path, kinds: [...set] }));
  return {
    tree,
    conflicts: all.slice(0, MAX_CONFLICT_FILES),
    moreConflicts: Math.max(0, all.length - MAX_CONFLICT_FILES),
  };
}

const refUpdateFailed = (branch: string): AppError =>
  conflict(`${branch} changed while it was being updated; read it again and retry`);

/**
 * Writing views of a project repository for integration work: merging branches into an issue
 * branch and fast-forwarding main. Everything runs on the bare repository with the fixed git
 * options of `Git` (no hooks, no fsmonitor, system and user configuration ignored); merges are
 * computed with `git merge-tree --write-tree`, which needs no work tree and runs no merge driver
 * the repository could configure for itself. Refs move with compare-and-swap `update-ref` only
 * after every step succeeded, so a refused call leaves every branch as it was.
 */
export class RepoMerger extends RepoReader {
  /** Whether `ancestor` is reachable from `descendant` (a commit counts as its own ancestor). */
  protected async isAncestor(
    projectId: string,
    ancestor: string,
    descendant: string,
  ): Promise<boolean> {
    const { exitCode } = await this.git.run(
      this.repoArgs(projectId, ['merge-base', '--is-ancestor', ancestor, descendant]),
      { timeoutMs: this.limits.timeoutMs, allowExitCodes: [1] },
    );
    return exitCode === 0;
  }

  /** The tree a merge of `theirs` into `ours` produces, with its conflicts; writes no ref. */
  protected async mergeTrees(projectId: string, ours: string, theirs: string): Promise<TreeMerge> {
    const { stdout } = await this.git.run(
      this.repoArgs(projectId, ['merge-tree', '--write-tree', '-z', '--name-only', ours, theirs]),
      { timeoutMs: this.limits.archiveTimeoutMs, allowExitCodes: [1] },
    );
    return parseMergeTree(stdout.toString('utf8'));
  }

  /** Write a commit of `tree` with `parents` and a fixed author and committer. */
  protected async writeCommit(
    projectId: string,
    tree: string,
    parents: readonly string[],
    message: string,
    identity: CommitIdentity,
  ): Promise<string> {
    const name = safeIdent(identity.name, 'Conclavix');
    const email = safeIdent(identity.email, `conclavix@${DEFAULT_AGENT_EMAIL_DOMAIN}`);
    const sha = (
      await this.git.text(
        this.repoArgs(projectId, [
          'commit-tree',
          tree,
          ...parents.flatMap((parent) => ['-p', parent]),
          '-F',
          '-',
        ]),
        {
          timeoutMs: this.limits.timeoutMs,
          input: message,
          env: {
            GIT_AUTHOR_NAME: name,
            GIT_AUTHOR_EMAIL: email,
            GIT_COMMITTER_NAME: name,
            GIT_COMMITTER_EMAIL: email,
          },
        },
      )
    ).trim();
    if (!OBJECT_ID.test(sha)) throw new Error('git commit-tree returned no commit id');
    return sha;
  }

  /** Move `refs/heads/<branch>` from `before` (null: must not exist) to `after`, or 409. */
  protected async moveBranch(
    projectId: string,
    branch: string,
    after: string,
    before: string | null,
  ): Promise<void> {
    try {
      await this.run(projectId, ['update-ref', `refs/heads/${branch}`, after, before ?? NO_REF]);
    } catch (error) {
      if (error instanceof GitError && error.reason === 'exit') throw refUpdateFailed(branch);
      throw error;
    }
  }

  /** The tip of an existing branch (not a commit id), or a 404 naming it. */
  async branchSha(projectId: string, branch: string): Promise<string> {
    await this.assertBranchName(branch);
    const sha = await this.commitOf(projectId, `refs/heads/${branch}`);
    if (!sha) throw notFound(`Branch ${branch}`);
    return sha;
  }

  /** Validate merge sources: distinct existing branches other than the target. */
  private async sourceTips(
    projectId: string,
    target: string,
    sources: readonly string[],
  ): Promise<{ source: string; sha: string }[]> {
    if (sources.length === 0 || sources.length > MAX_MERGE_SOURCES) {
      throw new AppError(400, 'invalid_sources', `name 1 to ${MAX_MERGE_SOURCES} source branches`);
    }
    if (new Set(sources).size !== sources.length) {
      throw new AppError(400, 'invalid_sources', 'source branches must be distinct');
    }
    if (sources.includes(target)) {
      throw new AppError(400, 'invalid_sources', 'the target cannot be one of its own sources');
    }
    const tips = [];
    for (const source of sources)
      tips.push({ source, sha: await this.branchSha(projectId, source) });
    return tips;
  }

  /**
   * Merge `sources` (existing branches, in order) into the issue branch `cvx/<issueKey>`. An
   * existing branch is the starting point; a missing one is created from `base` (default main).
   * Every source the target does not contain yet gets its own no-ff merge commit (first parent:
   * the target line) by `author`; sources already contained are skipped. The first conflict
   * refuses the whole call with 409 `merge_conflict` and its files, and no ref changes. The
   * branch moves once, at the end, with compare-and-swap.
   */
  async mergeIntoIssueBranch(
    projectId: string,
    issueKey: string,
    input: {
      sources: readonly string[];
      base?: string;
      message?: string;
      author: CommitIdentity;
      trailers?: readonly string[];
    },
  ): Promise<BranchMerge> {
    const target = await this.assertBranchName(issueBranchName(issueKey));
    await this.ensureRepo(projectId);
    return this.queue.run(`workspace:${projectId}:${issueKey}`, async () => {
      const tips = await this.sourceTips(projectId, target, input.sources);
      const before = await this.commitOf(projectId, `refs/heads/${target}`);
      const startedFrom: ResolvedRef = before
        ? { ref: target, sha: before }
        : {
            ref: input.base ?? DEFAULT_BRANCH,
            sha: await this.branchSha(projectId, input.base ?? DEFAULT_BRANCH),
          };
      const body = cleanMessage(input.message ?? '');
      const trailers = (input.trailers ?? []).map(oneLine).filter((line) => line !== '');
      let current = startedFrom.sha;
      const merges: MergeStep[] = [];
      for (const { source, sha } of tips) {
        if (await this.isAncestor(projectId, sha, current)) {
          merges.push({ source, sha, commit: null });
          continue;
        }
        const merged = await this.mergeTrees(projectId, current, sha);
        if (merged.conflicts.length > 0) {
          throw new AppError(409, 'merge_conflict', `${source} conflicts with ${target}`, {
            target,
            source,
            conflicts: merged.conflicts,
            moreConflicts: merged.moreConflicts,
            mergedCleanlyBefore: merges.filter((step) => step.commit).map((step) => step.source),
            hint: 'nothing was changed; resolve the conflicts on one of the branches and merge again',
          });
        }
        const subject = `Merge branch '${source}' into ${target}`;
        const message = [subject, body, trailers.join('\n')].filter((part) => part !== '');
        const commit = await this.writeCommit(
          projectId,
          merged.tree,
          [current, sha],
          `${message.join('\n\n')}\n`,
          input.author,
        );
        merges.push({ source, sha, commit });
        current = commit;
      }
      if (before !== current) await this.moveBranch(projectId, target, current, before);
      return {
        target,
        status: merges.some((step) => step.commit) ? 'merged' : 'up_to_date',
        created: before === null,
        startedFrom,
        before,
        after: current,
        merges,
      };
    });
  }

  /**
   * Fast-forward `branch` (main) to the tip of `source`, only when `source` contains it; a
   * diverged source is refused with 409 `not_fast_forward` and nothing changes.
   */
  async fastForwardBranch(
    projectId: string,
    branch: string,
    source: string,
  ): Promise<BranchPromotion> {
    await this.ensureRepo(projectId);
    return this.queue.run(`branch:${projectId}:${branch}`, async () => {
      const before = await this.branchSha(projectId, branch);
      const after = await this.branchSha(projectId, source);
      if (before === after) {
        return { branch, source, status: 'up_to_date', before, after, commits: 0 };
      }
      if (!(await this.isAncestor(projectId, before, after))) {
        const behind = await this.commitsBetween(projectId, after, before);
        throw new AppError(409, 'not_fast_forward', `${source} does not contain ${branch}`, {
          branch,
          source,
          missingCommits: behind,
          hint: `merge ${branch} into ${source} first (merge_branches with sources [${branch}]), let it be reviewed, then promote again`,
        });
      }
      const commits = await this.commitsBetween(projectId, before, after);
      await this.moveBranch(projectId, branch, after, before);
      return { branch, source, status: 'fast_forwarded', before, after, commits };
    });
  }

  /** Commits reachable from `tip` but not from `base`. */
  private async commitsBetween(projectId: string, base: string, tip: string): Promise<number> {
    return (
      Number((await this.text(projectId, ['rev-list', '--count', tip, `^${base}`])).trim()) || 0
    );
  }

  /**
   * Read-only preview of an integration: the target against main, whether main could be
   * fast-forwarded to it, and for each source whether the target contains it and which files
   * would conflict. Merge trees computed here are not referenced and change no branch.
   */
  async mergeStatus(
    projectId: string,
    target: string,
    sources: readonly string[],
    base: string = DEFAULT_BRANCH,
  ): Promise<MergeStatus> {
    await this.ensureRepo(projectId);
    await this.assertBranchName(target);
    const tips = sources.length > 0 ? await this.sourceTips(projectId, target, sources) : [];
    const main = await this.branchSha(projectId, DEFAULT_BRANCH);
    const tip = await this.commitOf(projectId, `refs/heads/${target}`);
    const start = tip ?? (await this.branchSha(projectId, base));
    const result: MergeStatus = {
      target,
      exists: tip !== null,
      tip,
      ahead: tip ? await this.commitsBetween(projectId, main, tip) : 0,
      behind: tip ? await this.commitsBetween(projectId, tip, main) : 0,
      canFastForwardMain: tip ? await this.isAncestor(projectId, main, tip) : false,
      sources: [],
    };
    for (const { source, sha } of tips) {
      const contained = await this.isAncestor(projectId, sha, start);
      const merged = contained ? null : await this.mergeTrees(projectId, start, sha);
      result.sources.push({
        source,
        sha,
        contained,
        conflicts: merged?.conflicts ?? [],
        moreConflicts: merged?.moreConflicts ?? 0,
      });
    }
    return result;
  }
}
