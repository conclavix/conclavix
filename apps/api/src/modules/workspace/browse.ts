import type { Readable } from 'node:stream';
import { DEFAULT_BRANCH, type DiffQuery, type RefDiff } from '@conclavix/core';
import { AppError, notFound } from '../../errors.js';
import { COMMIT_FORMAT, parseCommitLog } from './parse.js';
import { RepoReader } from './reader.js';
import { EMPTY_TREE, OBJECT_ID, type ResolvedRef } from './repo-base.js';

/** Refs a commit id given to a reading diff must be reachable from. */
export const READABLE_FROM: readonly string[] = ['refs/heads/', 'refs/tags/'];

/** A blob found for a download: its commit, object id, size, and a way to stream it. */
export interface DownloadBlob {
  sha: string;
  oid: string;
  size: number;
  open: () => Readable;
}

/** The file browser of the Code tab: downloads of any file, folder archives and ref diffs. */
export class RepoBrowser extends RepoReader {
  /**
   * Resolve a branch, a tag or a commit id for reading. A commit id must be reachable from a
   * branch or tag of the project, so objects no ref points to stay hidden. Names git rejects are
   * a 400, unknown or unreachable refs a 404.
   */
  async resolveReadable(projectId: string, ref: string): Promise<ResolvedRef> {
    await this.ensureRepo(projectId);
    await this.assertBranchName(ref);
    for (const prefix of READABLE_FROM) {
      const sha = await this.commitOf(projectId, `${prefix}${ref}`);
      if (sha) return { ref, sha };
    }
    if (OBJECT_ID.test(ref)) return this.resolveReachable(projectId, ref, READABLE_FROM);
    throw notFound(`Ref ${ref}`);
  }

  /**
   * The file at `path` in `ref` for a download, refused with 413 above the download limit before
   * any content is read. The stream is opened only when the caller asks for it.
   */
  async downloadBlob(projectId: string, ref: string, path: string): Promise<DownloadBlob> {
    const resolved = await this.resolveRef(projectId, ref);
    const entry = await this.entryAt(projectId, resolved.sha, path);
    if (!entry || entry.type !== 'blob') throw notFound(`File ${path}`);
    const size = entry.size ?? 0;
    if (size > this.limits.maxDownloadBytes) {
      throw new AppError(
        413,
        'file_too_large',
        `The file is larger than ${this.limits.maxDownloadBytes} bytes`,
      );
    }
    const oid = entry.oid;
    if (!OBJECT_ID.test(oid)) throw new Error('invalid object id');
    return {
      sha: resolved.sha,
      oid,
      size,
      open: () =>
        this.git.stream(this.repoArgs(projectId, ['cat-file', 'blob', oid]), {
          timeoutMs: this.limits.archiveTimeoutMs,
          maxBytes: this.limits.maxDownloadBytes,
        }),
    };
  }

  /** The tree id of the directory `path` in commit `sha`; 404 when it is no directory there. */
  async directoryTree(projectId: string, sha: string, path: string): Promise<string> {
    const entry = await this.entryAt(projectId, sha, path);
    if (!entry || entry.type !== 'tree') throw notFound(`Directory ${path}`);
    return entry.oid;
  }

  /**
   * A diff for review: one commit against its first parent, or `from` (default main) against
   * `to`, from their merge base or directly, optionally restricted to one path.
   */
  async refDiff(projectId: string, query: DiffQuery): Promise<RefDiff> {
    const paths = [query.path, query.oldPath].filter((path): path is string => path !== undefined);
    const full = query.path !== undefined;
    if (query.commit !== undefined) {
      return this.commitDiff(projectId, query.commit, paths, full);
    }
    const from = await this.resolveReadable(projectId, query.from ?? DEFAULT_BRANCH);
    const to = await this.resolveReadable(projectId, query.to ?? DEFAULT_BRANCH);
    const direct = query.mode === 'direct';
    const comparison = await this.compareCommits(projectId, from, to, { paths, direct, full });
    return {
      mode: query.mode,
      from: from.ref,
      to: to.ref,
      fromSha: from.sha,
      toSha: to.sha,
      mergeBase: comparison.mergeBase,
      diffBase: direct ? from.sha : comparison.mergeBase,
      ahead: comparison.ahead,
      behind: comparison.behind,
      commits: comparison.commits,
      path: query.path ?? null,
      diff: comparison.diff,
    };
  }

  /** One reachable commit against its first parent (the empty tree for a root commit). */
  private async commitDiff(
    projectId: string,
    id: string,
    paths: string[],
    full: boolean,
  ): Promise<RefDiff> {
    const commit = await this.resolveReadable(projectId, id);
    const output = await this.text(projectId, [
      'log',
      '-1',
      '-z',
      `--format=${COMMIT_FORMAT}`,
      commit.sha,
      '--',
    ]);
    const summary = parseCommitLog(output)[0];
    if (!summary) throw notFound(`Commit ${id}`);
    const parent = summary.parents[0] ?? null;
    return {
      mode: 'commit',
      from: parent,
      to: commit.ref,
      fromSha: parent,
      toSha: commit.sha,
      mergeBase: null,
      diffBase: parent,
      ahead: 0,
      behind: 0,
      commits: [summary],
      path: paths[0] ?? null,
      diff: await this.diff(projectId, parent ?? EMPTY_TREE, commit.sha, paths, { full }),
    };
  }
}
