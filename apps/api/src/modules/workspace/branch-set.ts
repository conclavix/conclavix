import { DEFAULT_BRANCH, ISSUE_BRANCH_PREFIX, issueBranchName } from '@conclavix/core';
import { AppError } from '../../errors.js';
import { RepoMerger } from './merge.js';
import { NO_REF, OBJECT_ID } from './repo-base.js';

/** Where `setBranch` keeps the old head of a branch it rewound. */
export const BACKUP_REF_ROOT = 'refs/backup/';

/** Backup refs of one branch: `refs/backup/<branch>/<time>-<sha>`. */
export const backupRefPrefix = (branch: string): string => `${BACKUP_REF_ROOT}${branch}/`;

/** Backup refs of one branch that the rewind check of a clone looks at, newest first. */
const MAX_BACKUPS_CHECKED = 50;

export interface BranchSet {
  branch: string;
  /** What the caller asked for (a branch name or a commit id) and the commit it resolved to. */
  requested: string;
  commit: string;
  /**
   * created: the branch did not exist; fast_forwarded: it moved forward; rewound: it moved to a
   * commit that does not contain its old head (allowRewind), which is kept as `backupRef`;
   * up_to_date: it already was at the commit.
   */
  status: 'created' | 'fast_forwarded' | 'rewound' | 'up_to_date';
  before: string | null;
  after: string;
  /** Commits the branch gained, and commits of its old head it no longer contains. */
  commits: number;
  dropped: number;
  backupRef: string | null;
}

/** `20261009T101500Z`: a ref-safe UTC time stamp. */
const stamp = (now: Date): string => now.toISOString().replace(/[-:]|\.\d+/g, '');

/**
 * Setting an issue branch to a given commit on the project repository: the server-side
 * replacement for `git reset` in an issue clone. Like the merges, it only writes refs of the bare
 * repository, with compare-and-swap, and never touches `main`.
 */
export class RepoBrancher extends RepoMerger {
  /**
   * Point `cvx/<issueKey>` at `commit` (a branch or a commit id reachable from a branch or a
   * backup ref). A missing branch is created; an existing one moves forward only, unless
   * `allowRewind` is set: then a move that drops commits is made too, after the old head was
   * stored as `refs/backup/<branch>/<time>-<sha>`, which the runner's reconciliation uses to tell
   * a rewound branch from a clone that is merely ahead. Refused moves change nothing.
   */
  async setIssueBranch(
    projectId: string,
    issueKey: string,
    input: { commit: string; allowRewind?: boolean; now?: Date },
  ): Promise<BranchSet> {
    const branch = await this.assertBranchName(issueBranchName(issueKey));
    if (branch === DEFAULT_BRANCH || !branch.startsWith(ISSUE_BRANCH_PREFIX)) {
      throw new AppError(400, 'invalid_branch', `only issue branches can be set, not ${branch}`);
    }
    await this.ensureRepo(projectId);
    return this.queue.run(`workspace:${projectId}:${issueKey}`, async () => {
      const after = (await this.resolveReachable(projectId, input.commit)).sha;
      const before = await this.commitOf(projectId, `refs/heads/${branch}`);
      const result = { branch, requested: input.commit, commit: after, before, after };
      const none = { commits: 0, dropped: 0, backupRef: null };
      if (before === after) return { ...result, ...none, status: 'up_to_date' as const };
      if (!before) {
        await this.moveBranch(projectId, branch, after, null);
        return { ...result, ...none, status: 'created' as const };
      }
      const commits = await this.commitsBetween(projectId, before, after);
      if (await this.isAncestor(projectId, before, after)) {
        await this.moveBranch(projectId, branch, after, before);
        return { ...result, ...none, commits, status: 'fast_forwarded' as const };
      }
      const dropped = await this.commitsBetween(projectId, after, before);
      if (input.allowRewind !== true) {
        throw new AppError(
          409,
          'not_fast_forward',
          `${branch} is not an ancestor of ${input.commit}`,
          {
            branch,
            before,
            commit: after,
            dropped,
            hint: 'nothing was changed; pass allowRewind: true to move the branch anyway (its old head is kept as a backup ref)',
          },
        );
      }
      const backupRef = `${backupRefPrefix(branch)}${stamp(input.now ?? new Date())}-${before.slice(0, 12)}`;
      await this.run(projectId, ['update-ref', backupRef, before, NO_REF]);
      await this.moveBranch(projectId, branch, after, before);
      return { ...result, commits, dropped, backupRef, status: 'rewound' as const };
    });
  }

  /**
   * Old heads of `branch` that `setIssueBranch` rewound away and that `server` (the branch's tip)
   * does not contain, newest first. A clone holding one of them must not be synced or merged
   * back: that would bring the dropped commits back onto the branch.
   */
  async rewoundHeads(projectId: string, branch: string, server: string): Promise<string[]> {
    const listed = await this.text(projectId, [
      'for-each-ref',
      '--sort=-refname',
      `--count=${MAX_BACKUPS_CHECKED}`,
      '--format=%(objectname)',
      backupRefPrefix(branch),
    ]);
    const heads: string[] = [];
    for (const sha of new Set(listed.split('\n').filter((line) => OBJECT_ID.test(line)))) {
      if (!(await this.isAncestor(projectId, sha, server))) heads.push(sha);
    }
    return heads;
  }
}
