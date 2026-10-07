import { randomBytes } from 'node:crypto';
import { lstat, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { issueBranchName } from '@conclavix/core';
import { AppError, notFound } from '../../errors.js';
import {
  checkoutClone,
  cloneGit,
  commitTree,
  dropRef,
  hasUncommittedWork,
  resetCloneConfig,
  snapshotWorkTree,
  withWarnings,
  type CloneGit,
} from './clone-git.js';
import { safeIdent, type CommitIdentity } from './identity.js';
import type { ConflictFile } from './merge.js';
import { removeSandboxPlaceholders } from './placeholders.js';
import { EMPTY_TREE, NO_REF, isMissing } from './repo-base.js';
import { Workspace } from './service.js';

export { safeIdent };
export { CLONE_CONFIG, DEFAULT_EXCLUDES } from './clone-git.js';

/** Where the runner fetches the server's issue branch into a clone while reconciling the two. */
const SERVER_TIP_REF = 'refs/conclavix/server';

/** Fast-forward checkout of the clone; false when it would overwrite files in the work tree. */
async function checkedOut(
  git: CloneGit,
  gitDir: string,
  ref: string,
  from: string,
  to: string,
): Promise<boolean> {
  try {
    await checkoutClone(git, gitDir, ref, { from, to, force: false });
    return true;
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 409) return false;
    throw error;
  }
}

export interface CloneReconcile {
  /**
   * none: nothing to do (the clone holds the server tip or is ahead of it); fast_forward: the
   * clone moved to the server tip; merged: both lines were merged; preserved: the merge
   * conflicted, the clone's tip is kept as `preservedBranch` and the clone was reset; set_aside:
   * the clone was moved to `setAside` and a fresh clone of the server branch is needed.
   */
  action: 'none' | 'fast_forward' | 'merged' | 'preserved' | 'set_aside';
  server: string | null;
  clone: string | null;
  /** The clone's tip afterwards. */
  head: string | null;
  merge?: string;
  preservedBranch?: string;
  conflicts?: ConflictFile[];
  setAside?: string;
  /** Problems that did not stop the reconciliation, such as a temporary ref left behind. */
  warnings: string[];
}

export interface CommitAuthor {
  name: string;
  email: string;
}

export interface CloneCommitInput {
  author: CommitAuthor;
  message: string;
  /** The server tip of the issue branch before the run; the diff stats are taken against it. */
  base: string | null;
}

export interface DiffStats {
  files: number;
  insertions: number;
  deletions: number;
}

/** Stats reported when the diff after a successful commit cannot be computed. */
const UNKNOWN_STATS: DiffStats = { files: 0, insertions: 0, deletions: 0 };

export interface CloneCommit {
  branch: string;
  /** The new tip of the issue branch in the clone. */
  head: string;
  /** The commit the runner made, or null when the work tree had no changes. */
  commit: string | null;
  /** Commits the agent made itself in the clone during the run (on top of the base). */
  agentCommits: number;
  /**
   * True when the clone's branch no longer contained the base (the agent reset or rebased it):
   * the work tree was then committed on top of the base instead, so the sync stays a
   * fast-forward and the agent's rewritten commits are not kept.
   */
  rewritten: boolean;
  stats: DiffStats;
}

/** Sum a `git diff --numstat` output; binary files count as changed without lines. */
export function sumNumstat(output: string): DiffStats {
  const stats: DiffStats = { files: 0, insertions: 0, deletions: 0 };
  for (const line of output.split('\n')) {
    const [added, removed] = line.split('\t');
    if (added === undefined || removed === undefined) continue;
    stats.files += 1;
    stats.insertions += /^\d+$/.test(added) ? Number(added) : 0;
    stats.deletions += /^\d+$/.test(removed) ? Number(removed) : 0;
  }
  return stats;
}

/**
 * Workspace operations of the runner: committing what an agent left in its clone. Git runs inside
 * the clone here (clone-git.ts), unlike in Workspace, so the clone's `.git` is checked first, its
 * configuration is replaced by CLONE_CONFIG and the index is a fresh one built from the branch tip.
 */
export class CodeWorkspace extends Workspace {
  /**
   * The checked `.git` of an issue clone, after removing what Claude Code's Bash sandbox left in
   * it (see removeSandboxPlaceholders). The runner only gets here while no sandbox unit runs in
   * the clone: before a run starts and after its unit has ended.
   */
  protected override async cloneGitDir(projectId: string, issueKey: string): Promise<string> {
    const gitDir = join(this.issueWorkspaceDir(projectId, issueKey), '.git');
    let isDirectory = false;
    try {
      isDirectory = (await lstat(gitDir)).isDirectory();
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (isDirectory) await removeSandboxPlaceholders(gitDir);
    return super.cloneGitDir(projectId, issueKey);
  }

  /** The tip of `cvx/<issueKey>` in the project repository, or null without that branch. */
  async branchTip(projectId: string, issueKey: string): Promise<string | null> {
    await this.ensureRepo(projectId);
    return this.commitOf(projectId, `refs/heads/${issueBranchName(issueKey)}`);
  }

  /**
   * Commit every change in the work tree of an issue clone on `cvx/<KEY>` with a fixed author.
   * Commits the agent made itself stay as they are; the runner's commit goes on top. If the agent
   * rewrote the branch so that it no longer contains `input.base`, the work tree is committed on
   * top of the base instead: the server branch is never rewritten, and the next sync is a
   * fast-forward. Returns the new tip, the commit (null without changes) and the diff stats
   * against `input.base`.
   */
  async commitIssueWork(
    projectId: string,
    issueKey: string,
    input: CloneCommitInput,
  ): Promise<CloneCommit> {
    const branch = await this.assertBranchName(issueBranchName(issueKey));
    const ref = `refs/heads/${branch}`;
    await this.ensureRepo(projectId);
    return this.queue.run(`workspace:${projectId}:${issueKey}`, async () => {
      const gitDir = await this.cloneGitDir(projectId, issueKey);
      await resetCloneConfig(gitDir);
      const git = this.cloneGit(gitDir);
      const tip = await git.commit(ref);
      const base = await git.commit(input.base ?? '');
      const rewritten = tip !== null && base !== null && !(await git.isAncestor(base, tip));
      const parent = rewritten ? base : (tip ?? base);
      if (!parent) throw notFound(`Branch ${branch} in the workspace of ${issueKey}`);
      const index = join(gitDir, `cvx-index-${randomBytes(6).toString('hex')}`);
      try {
        const tree = await snapshotWorkTree(git, index, parent);
        const parentTree = (await git.text(['rev-parse', `${parent}^{tree}`])).trim();
        let head = parent;
        let commit: string | null = null;
        if (tree !== parentTree) {
          commit = await commitTree(git, tree, parent, input.author, input.message);
          head = commit;
        }
        await git.run(['update-ref', ref, head, tip ?? NO_REF]);
        await git.run(['symbolic-ref', 'HEAD', ref]);
        await rename(index, join(gitDir, 'index'));
        return {
          branch,
          head,
          commit,
          agentCommits: await this.countCommits(git, base, parent).catch(() => 0),
          rewritten,
          stats: await this.diffStats(git, base, head).catch(() => UNKNOWN_STATS),
        };
      } finally {
        await rm(index, { force: true });
      }
    });
  }

  /**
   * Whether the clone holds uncommitted work (see hasUncommittedWork). A check that fails counts
   * as uncommitted work, so the clone is set aside instead of blocking every later run.
   */
  private async hasLeftovers(
    git: CloneGit,
    gitDir: string,
    tip: string,
    warnings: string[],
  ): Promise<boolean> {
    const index = join(gitDir, `cvx-index-${randomBytes(6).toString('hex')}`);
    try {
      return await hasUncommittedWork(git, index, tip);
    } catch (error) {
      warnings.push(`checking the work tree failed: ${(error as Error).message}`);
      return true;
    } finally {
      await rm(index, { force: true });
    }
  }

  /**
   * Move an issue clone out of the way, next to where it was, as `.stale-<KEY>-<time>-<random>`
   * (never committed, never deleted by the server), so the next workspace call clones the server
   * branch afresh. Returns the new path.
   */
  private async setAside(projectId: string, issueKey: string): Promise<string> {
    const dir = this.issueWorkspaceDir(projectId, issueKey);
    const suffix = `${Date.now()}-${randomBytes(3).toString('hex')}`;
    const target = join(dirname(dir), `.stale-${issueKey}-${suffix}`);
    await rename(dir, target);
    return target;
  }

  /**
   * Bring an issue clone and the server's `cvx/<KEY>` together after the server branch moved
   * without the clone (an integration merge into it). A clone ahead of the server stays as it is
   * (the sync after the run brings it over). A clone behind the server is fast-forwarded; a clone
   * that has commits the server lacks and lacks the server's is merged with it on the server side
   * (no-ff, first parent: the clone's line, by `author`) and then fast-forwarded. When that merge
   * conflicts, the clone's tip is kept as the branch `conflict/<KEY>/<sha>` in the project
   * repository and the clone is reset to the server tip. A clone that still holds uncommitted
   * work of an earlier run (its sandbox stopped it, or its commit failed), or whose checkout would
   * overwrite files, is set aside (see setAside) instead of being committed or overwritten; the
   * caller then creates a fresh clone. The server branch only moves forward, with
   * compare-and-swap. Runs only while no sandbox works in the clone.
   */
  async reconcileClone(
    projectId: string,
    issueKey: string,
    author: CommitIdentity,
  ): Promise<CloneReconcile> {
    const branch = await this.assertBranchName(issueBranchName(issueKey));
    const ref = `refs/heads/${branch}`;
    await this.ensureRepo(projectId);
    return this.queue.run(`workspace:${projectId}:${issueKey}`, async () => {
      const gitDir = await this.cloneGitDir(projectId, issueKey);
      const server = await this.commitOf(projectId, ref);
      await resetCloneConfig(gitDir);
      const git = this.cloneGit(gitDir);
      const clone = await git.commit(ref);
      const warnings: string[] = [];
      const none: CloneReconcile = { action: 'none', server, clone, head: clone, warnings };
      if (!server || !clone || server === clone) return none;
      const state: { aside: string | null } = { aside: null };
      const aside = async (): Promise<CloneReconcile> => {
        state.aside = await this.setAside(projectId, issueKey);
        return { action: 'set_aside', server, clone, head: null, setAside: state.aside, warnings };
      };
      const dropServerTip = async () => {
        if (state.aside) return;
        await dropRef(warnings, SERVER_TIP_REF, () =>
          git.run(['update-ref', '-d', SERVER_TIP_REF]),
        );
      };
      try {
        await this.fetchIntoClone(projectId, git, ref);
        let result = none;
        if (await git.isAncestor(server, clone)) {
          result = none;
        } else if (await this.hasLeftovers(git, gitDir, clone, warnings)) {
          result = await aside();
        } else if (await git.isAncestor(clone, server)) {
          result = (await checkedOut(git, gitDir, ref, clone, server))
            ? { action: 'fast_forward', server, clone, head: server, warnings }
            : await aside();
        } else {
          result = await this.mergeDiverged(projectId, issueKey, gitDir, git, {
            ref,
            branch,
            server,
            clone,
            author,
            warnings,
            aside,
          });
        }
        await dropServerTip();
        return result;
      } catch (error) {
        await dropServerTip();
        throw withWarnings(error, warnings);
      }
    });
  }

  /** Merge a diverged clone with the server branch on the server side; see reconcileClone. */
  private async mergeDiverged(
    projectId: string,
    issueKey: string,
    gitDir: string,
    git: CloneGit,
    tips: {
      ref: string;
      branch: string;
      server: string;
      clone: string;
      author: CommitIdentity;
      warnings: string[];
      aside: () => Promise<CloneReconcile>;
    },
  ): Promise<CloneReconcile> {
    const { ref, branch, server, clone, author, warnings, aside } = tips;
    const incoming = `refs/conclavix/incoming/${issueKey}`;
    await this.fromClone(projectId, gitDir, [
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      '--no-recurse-submodules',
      '--no-auto-gc',
      gitDir,
      `+${ref}:${incoming}`,
    ]);
    const dropIncoming = () =>
      dropRef(warnings, incoming, () => this.run(projectId, ['update-ref', '-d', incoming]));
    try {
      const merged = await this.mergeTrees(projectId, clone, server);
      if (merged.conflicts.length > 0) {
        const preserved = `conflict/${issueKey}/${clone.slice(0, 12)}`;
        const existing = await this.commitOf(projectId, `refs/heads/${preserved}`);
        if (existing !== clone) await this.moveBranch(projectId, preserved, clone, existing);
        await checkoutClone(git, gitDir, ref, { from: clone, to: server, force: true });
        return {
          action: 'preserved',
          server,
          clone,
          head: server,
          preservedBranch: preserved,
          conflicts: merged.conflicts,
          warnings,
        };
      }
      const message = [
        `Merge the server's ${branch} into the workspace's work`,
        '',
        `The server branch moved to ${server.slice(0, 12)} while the workspace was at`,
        `${clone.slice(0, 12)}; both lines are kept.`,
        '',
      ].join('\n');
      const commit = await this.writeCommit(
        projectId,
        merged.tree,
        [clone, server],
        message,
        author,
      );
      await this.moveBranch(projectId, branch, commit, server);
      await this.fetchIntoClone(projectId, git, ref);
      if (!(await checkedOut(git, gitDir, ref, clone, commit))) {
        return { ...(await aside()), merge: commit };
      }
      return { action: 'merged', server, clone, head: commit, merge: commit, warnings };
    } finally {
      await dropIncoming();
    }
  }

  /**
   * Fetch the server's `cvx/<KEY>` into the clone as SERVER_TIP_REF. git runs in the clone (its
   * configuration was just replaced); the other side is the bare repository, which belongs to
   * the API user, so it is marked as a safe directory for this call.
   */
  private async fetchIntoClone(projectId: string, git: CloneGit, ref: string): Promise<void> {
    const repo = this.repoDir(projectId);
    await this.withSafeDirectory(repo, (env) =>
      git.run(
        [
          '-c',
          'protocol.file.allow=always',
          'fetch',
          '--no-tags',
          '--no-write-fetch-head',
          '--no-recurse-submodules',
          '--no-auto-gc',
          repo,
          `+${ref}:${SERVER_TIP_REF}`,
        ],
        { env },
      ),
    );
  }

  private cloneGit(gitDir: string): CloneGit {
    return cloneGit(this.git, gitDir, this.limits.archiveTimeoutMs);
  }

  private async countCommits(git: CloneGit, base: string | null, tip: string): Promise<number> {
    const range = base ? [`${base}..${tip}`] : [tip];
    return Number((await git.text(['rev-list', '--count', ...range])).trim()) || 0;
  }

  private async diffStats(git: CloneGit, base: string | null, head: string): Promise<DiffStats> {
    if (base === head) return { files: 0, insertions: 0, deletions: 0 };
    const output = await git.text([
      'diff',
      '--numstat',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      base ?? EMPTY_TREE,
      head,
    ]);
    return sumNumstat(output);
  }
}
