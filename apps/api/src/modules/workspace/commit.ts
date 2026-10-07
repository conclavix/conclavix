import { randomBytes } from 'node:crypto';
import { lstat, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { issueBranchName } from '@conclavix/core';
import { conflict, notFound } from '../../errors.js';
import type { GitCallOptions } from './git.js';
import { GitError } from './git.js';
import { safeIdent, type CommitIdentity } from './identity.js';
import type { ConflictFile } from './merge.js';
import { removeSandboxPlaceholders } from './placeholders.js';
import { EMPTY_TREE, NO_REF, OBJECT_ID, isMissing } from './repo-base.js';
import { Workspace } from './service.js';

export { safeIdent };

/** Where the runner fetches the server's issue branch into a clone while reconciling the two. */
const SERVER_TIP_REF = 'refs/conclavix/server';

export interface CloneReconcile {
  /**
   * none: nothing to do (the clone holds the server tip or is ahead of it); fast_forward: the
   * clone moved to the server tip; merged: both lines were merged; preserved: the merge
   * conflicted, the clone's tip is kept as `preservedBranch` and the clone was reset.
   */
  action: 'none' | 'fast_forward' | 'merged' | 'preserved';
  server: string | null;
  clone: string | null;
  /** The clone's tip afterwards. */
  head: string | null;
  merge?: string;
  preservedBranch?: string;
  conflicts?: ConflictFile[];
}

/**
 * The only configuration an issue clone keeps when the runner commits in it; whatever an agent
 * wrote to `.git/config` (filters, includes, fsmonitor, hooks path, worktree) is replaced.
 */
export const CLONE_CONFIG = [
  '[core]',
  '\trepositoryformatversion = 0',
  '\tfilemode = true',
  '\tbare = false',
  '\tlogallrefupdates = true',
  '\tsymlinks = true',
  '\tautocrlf = false',
  '\tsharedRepository = 0660',
  '',
].join('\n');

/** Paths a run's commit never picks up, on top of the clone's own .gitignore. */
export const DEFAULT_EXCLUDES = [
  'node_modules/',
  '.venv/',
  '__pycache__/',
  '.pytest_cache/',
  '.mypy_cache/',
  '.cache/',
  '.npm/',
];

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
 * the clone here, unlike in Workspace, so the clone's `.git` is checked first, its configuration
 * is replaced by CLONE_CONFIG and the index is a fresh one built from the branch tip.
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
      await this.resetCloneConfig(gitDir);
      const git = this.cloneGit(gitDir);
      const tip = await git.commit(ref);
      const base = await git.commit(input.base ?? '');
      const rewritten = tip !== null && base !== null && !(await git.isAncestor(base, tip));
      const parent = rewritten ? base : (tip ?? base);
      if (!parent) throw notFound(`Branch ${branch} in the workspace of ${issueKey}`);
      const index = join(gitDir, `cvx-index-${randomBytes(6).toString('hex')}`);
      const excludes = await mkdtemp(join(tmpdir(), 'cvx-commit-'));
      try {
        const excludeFile = join(excludes, 'exclude');
        await writeFile(excludeFile, `${DEFAULT_EXCLUDES.join('\n')}\n`, { mode: 0o600 });
        const env = { GIT_INDEX_FILE: index };
        await git.run(['read-tree', parent], { env });
        await git.run(['-c', `core.excludesFile=${excludeFile}`, 'add', '-A', '--', '.'], { env });
        const tree = (await git.text(['write-tree'], { env })).trim();
        const parentTree = (await git.text(['rev-parse', `${parent}^{tree}`])).trim();
        let head = parent;
        let commit: string | null = null;
        if (tree !== parentTree) {
          commit = await this.commitTree(git, tree, parent, input);
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
        await rm(excludes, { recursive: true, force: true });
      }
    });
  }

  /**
   * Bring an issue clone and the server's `cvx/<KEY>` together after the server branch moved
   * without the clone (an integration merge into it): a clone behind the server is
   * fast-forwarded (a checkout that refuses to overwrite uncommitted changes); a clone that has
   * commits the server lacks and lacks the server's is merged with it on the server side (no-ff,
   * first parent: the clone's line, by `author`) and then fast-forwarded. When that merge
   * conflicts, the clone's tip is kept as the branch `conflict/<KEY>/<sha>` in the project
   * repository and the clone is reset to the server tip, so the issue continues from the server
   * branch and nothing is lost. The server branch only ever moves forward, with compare-and-swap.
   * Runs only while no sandbox works in the clone.
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
      await this.resetCloneConfig(gitDir);
      const git = this.cloneGit(gitDir);
      const clone = await git.commit(ref);
      const unchanged = { action: 'none', server, clone, head: clone } as const;
      if (!server || !clone || server === clone) return unchanged;
      await this.fetchIntoClone(projectId, git, ref);
      try {
        if (await git.isAncestor(server, clone)) return unchanged;
        if (await git.isAncestor(clone, server)) {
          await this.checkoutClone(git, gitDir, ref, clone, server, false);
          return { action: 'fast_forward', server, clone, head: server };
        }
        return await this.mergeDiverged(projectId, issueKey, gitDir, git, {
          ref,
          branch,
          server,
          clone,
          author,
        });
      } finally {
        await git.run(['update-ref', '-d', SERVER_TIP_REF]).catch(() => undefined);
      }
    });
  }

  /** Merge a diverged clone with the server branch on the server side; see reconcileClone. */
  private async mergeDiverged(
    projectId: string,
    issueKey: string,
    gitDir: string,
    git: ReturnType<CodeWorkspace['cloneGit']>,
    tips: { ref: string; branch: string; server: string; clone: string; author: CommitIdentity },
  ): Promise<CloneReconcile> {
    const { ref, branch, server, clone, author } = tips;
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
    try {
      const merged = await this.mergeTrees(projectId, clone, server);
      if (merged.conflicts.length > 0) {
        const preserved = `conflict/${issueKey}/${clone.slice(0, 12)}`;
        const existing = await this.commitOf(projectId, `refs/heads/${preserved}`);
        if (existing !== clone) await this.moveBranch(projectId, preserved, clone, existing);
        await this.checkoutClone(git, gitDir, ref, clone, server, true);
        return {
          action: 'preserved',
          server,
          clone,
          head: server,
          preservedBranch: preserved,
          conflicts: merged.conflicts,
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
      await this.checkoutClone(git, gitDir, ref, clone, commit, false);
      return { action: 'merged', server, clone, head: commit, merge: commit };
    } finally {
      await this.run(projectId, ['update-ref', '-d', incoming]).catch(() => undefined);
    }
  }

  /**
   * Fetch the server's `cvx/<KEY>` into the clone as SERVER_TIP_REF. git runs in the clone (its
   * configuration was just replaced); the other side is the bare repository, which belongs to
   * the API user, so it is marked as a safe directory for this call.
   */
  private async fetchIntoClone(
    projectId: string,
    git: ReturnType<CodeWorkspace['cloneGit']>,
    ref: string,
  ): Promise<void> {
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

  /**
   * Move the clone's branch from `from` to `to` and update the work tree. Without `force` this is
   * git's two-tree checkout, which refuses to overwrite uncommitted changes; with `force` the
   * work tree's tracked files become `to` exactly. A fresh index is built and moved into place.
   */
  private async checkoutClone(
    git: ReturnType<CodeWorkspace['cloneGit']>,
    gitDir: string,
    ref: string,
    from: string,
    to: string,
    force: boolean,
  ): Promise<void> {
    const index = join(gitDir, `cvx-index-${randomBytes(6).toString('hex')}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      await git.run(['read-tree', from], { env });
      if (force) {
        await git.run(['read-tree', '--reset', '-u', to], { env });
      } else {
        await git.run(['update-index', '-q', '--refresh'], { env, allowExitCodes: [1] });
        try {
          await git.run(['read-tree', '-m', '-u', from, to], { env });
        } catch (error) {
          if (error instanceof GitError && error.reason === 'exit') {
            throw conflict(
              `the workspace of ${ref.slice('refs/heads/'.length)} has uncommitted changes that the server branch would overwrite`,
              { hint: 'an admin can remove the workspace; the next run clones the server branch' },
            );
          }
          throw error;
        }
      }
      await git.run(['update-ref', ref, to, from]);
      await git.run(['symbolic-ref', 'HEAD', ref]);
      await rename(index, join(gitDir, 'index'));
    } finally {
      await rm(index, { force: true });
    }
  }

  private async resetCloneConfig(gitDir: string): Promise<void> {
    const temp = join(gitDir, `config.cvx-${randomBytes(6).toString('hex')}`);
    await writeFile(temp, CLONE_CONFIG, { mode: 0o660, flag: 'wx' });
    await rename(temp, join(gitDir, 'config'));
  }

  /** git with the clone as git directory and work tree, and the clone's commit lookup. */
  private cloneGit(gitDir: string) {
    const base = [`--git-dir=${gitDir}`, `--work-tree=${dirname(gitDir)}`];
    const options = (extra: GitCallOptions = {}): GitCallOptions => ({
      timeoutMs: this.limits.archiveTimeoutMs,
      cwd: dirname(gitDir),
      ...extra,
    });
    const run = (args: readonly string[], extra?: GitCallOptions) =>
      this.git.run([...base, ...args], options(extra));
    const text = (args: readonly string[], extra?: GitCallOptions) =>
      this.git.text([...base, ...args], options(extra));
    const commit = async (revision: string): Promise<string | null> => {
      if (revision === '') return null;
      try {
        const sha = await text(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]);
        return OBJECT_ID.test(sha) ? sha : null;
      } catch (error) {
        if (error instanceof GitError && error.reason === 'exit') return null;
        throw error;
      }
    };
    /** Whether `ancestor` is reachable from `descendant` (a commit counts as its own ancestor). */
    const isAncestor = async (ancestor: string, descendant: string): Promise<boolean> => {
      try {
        await run(['merge-base', '--is-ancestor', ancestor, descendant]);
        return true;
      } catch (error) {
        if (error instanceof GitError && error.reason === 'exit' && error.exitCode === 1) {
          return false;
        }
        throw error;
      }
    };
    return { run, text, commit, isAncestor };
  }

  private async commitTree(
    git: ReturnType<CodeWorkspace['cloneGit']>,
    tree: string,
    parent: string,
    input: CloneCommitInput,
  ): Promise<string> {
    const name = safeIdent(input.author.name, 'Conclavix');
    const email = safeIdent(input.author.email, 'conclavix@localhost');
    const sha = await git.text(['commit-tree', tree, '-p', parent, '-F', '-'], {
      input: input.message,
      env: {
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: email,
      },
    });
    if (!OBJECT_ID.test(sha)) throw new Error('git commit-tree returned no commit id');
    return sha;
  }

  private async countCommits(
    git: ReturnType<CodeWorkspace['cloneGit']>,
    base: string | null,
    tip: string,
  ): Promise<number> {
    const range = base ? [`${base}..${tip}`] : [tip];
    return Number((await git.text(['rev-list', '--count', ...range])).trim()) || 0;
  }

  private async diffStats(
    git: ReturnType<CodeWorkspace['cloneGit']>,
    base: string | null,
    head: string,
  ): Promise<DiffStats> {
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
