import type { Readable } from 'node:stream';
import {
  DEFAULT_BRANCH,
  type BranchComparison,
  type BranchInfo,
  type CommitDetail,
  type CommitLogQuery,
  type CommitPage,
  type Diff,
  type FileContent,
  type TreeListing,
} from '@conclavix/core';
import { AppError, notFound } from '../../errors.js';
import { GitError } from './git.js';
import {
  BRANCH_FORMAT,
  COMMIT_FORMAT,
  FIELD,
  buildFileDiffs,
  looksBinary,
  parseBranches,
  parseCommit,
  parseCommitLog,
  parseLsTree,
  parseNumstat,
  parseRawDiff,
  splitPatch,
  toTreeEntries,
} from './parse.js';
import {
  DIFF_FLAGS,
  EMPTY_TREE,
  OBJECT_ID,
  RepoBase,
  assertRepoPath,
  type ResolvedRef,
} from './repo-base.js';

/** Read-only views of a project repository: branches, history, diffs, files and archives. */
export class RepoReader extends RepoBase {
  /**
   * Branches with ahead/behind against main and their last commit: main first, then the most
   * recently committed ones up to the branch limit.
   */
  async listBranches(projectId: string): Promise<BranchInfo[]> {
    await this.ensureRepo(projectId);
    const list = (count: number, pattern: string) =>
      this.text(projectId, [
        'for-each-ref',
        `--format=${BRANCH_FORMAT}`,
        '--sort=-committerdate',
        `--count=${count}`,
        pattern,
      ]);
    const [main, newest] = await Promise.all([
      list(1, `refs/heads/${DEFAULT_BRANCH}`),
      list(this.limits.maxBranches, 'refs/heads/'),
    ]);
    const branches = parseBranches(`${main}\n${newest}`);
    const unique = branches.filter(
      (branch, index) => branches.findIndex((other) => other.name === branch.name) === index,
    );
    return unique.slice(0, this.limits.maxBranches);
  }

  /** A page of the history of `ref`, newest first. */
  async log(projectId: string, query: CommitLogQuery): Promise<CommitPage> {
    const { sha } = await this.resolveRef(projectId, query.ref);
    const output = await this.text(projectId, [
      'log',
      '-z',
      `--format=${COMMIT_FORMAT}`,
      `--max-count=${query.limit + 1}`,
      `--skip=${query.skip}`,
      sha,
      '--',
    ]);
    const commits = parseCommitLog(output);
    const more = commits.length > query.limit;
    return {
      items: commits.slice(0, query.limit),
      nextSkip: more ? query.skip + query.limit : null,
    };
  }

  /** One commit with its message body and its diff against the first parent. */
  async commit(projectId: string, id: string): Promise<CommitDetail> {
    await this.ensureRepo(projectId);
    if (!OBJECT_ID.test(id)) throw notFound('Commit');
    const sha = await this.commitOf(projectId, id);
    if (!sha) throw notFound('Commit');
    const output = await this.text(projectId, [
      'log',
      '-1',
      `--format=${COMMIT_FORMAT}%x1f%b`,
      sha,
      '--',
    ]);
    const { rest, ...summary } = parseCommit(output);
    const parent = summary.parents[0] ?? EMPTY_TREE;
    return {
      ...summary,
      body: rest.join(FIELD).trimEnd(),
      diff: await this.diff(projectId, parent, sha),
    };
  }

  /**
   * The diff between two resolved commits (or the empty tree), with size limits. `paths`
   * restricts it to those files or directories (literal pathspecs).
   */
  async diff(projectId: string, from: string, to: string, paths: string[] = []): Promise<Diff> {
    if (!OBJECT_ID.test(from) || !OBJECT_ID.test(to)) throw new Error('unresolved diff range');
    for (const path of paths) {
      assertRepoPath(path);
      if (path === '') throw new Error('empty diff path');
    }
    const range = [from, to, '--', ...paths];
    const cut = (format: string[], maxBytes: number) =>
      this.git.run(this.repoArgs(projectId, ['diff', ...DIFF_FLAGS, ...format, ...range]), {
        timeoutMs: this.limits.timeoutMs,
        maxBytes,
        allowTruncate: true,
      });
    const [raw, numstat, patch] = await Promise.all([
      cut(['--raw', '-z'], this.limits.maxListBytes),
      cut(['--numstat', '-z'], this.limits.maxListBytes),
      cut(['-p'], this.limits.maxPatchBytes),
    ]);
    const changes = parseRawDiff(raw.stdout.toString('utf8'));
    const stats = parseNumstat(numstat.stdout.toString('utf8'));
    if (raw.truncated || numstat.truncated) {
      const complete = Math.max(0, Math.min(changes.length, stats.length) - 1);
      changes.length = complete;
      stats.length = complete;
    }
    const result = buildFileDiffs(
      changes,
      stats,
      splitPatch(patch.stdout.toString('utf8')),
      patch.truncated,
      { maxFiles: this.limits.maxDiffFiles, maxFilePatchBytes: this.limits.maxFilePatchBytes },
    );
    return { ...result, truncated: result.truncated || raw.truncated || numstat.truncated };
  }

  /** Compare a branch with main: merge base, ahead/behind, its own commits and its diff. */
  async compare(projectId: string, branch: string): Promise<BranchComparison> {
    const base = await this.resolveRef(projectId, DEFAULT_BRANCH);
    await this.assertBranchName(branch);
    const headSha = await this.commitOf(projectId, `refs/heads/${branch}`);
    if (!headSha) throw notFound(`Branch ${branch}`);
    return this.compareCommits(projectId, base, { ref: branch, sha: headSha });
  }

  /**
   * Compare two resolved commits the way a pull request does: merge base, ahead/behind, the
   * commits `head` has that `base` lacks, and the diff from the merge base to `head`, optionally
   * restricted to `paths`.
   */
  async compareCommits(
    projectId: string,
    base: ResolvedRef,
    head: ResolvedRef,
    options: { paths?: string[] } = {},
  ): Promise<BranchComparison> {
    if (!OBJECT_ID.test(base.sha) || !OBJECT_ID.test(head.sha)) {
      throw new Error('unresolved comparison');
    }
    let mergeBase: string | null = null;
    try {
      mergeBase = (await this.text(projectId, ['merge-base', base.sha, head.sha])).trim() || null;
    } catch (error) {
      if (!(error instanceof GitError && error.reason === 'exit')) throw error;
    }
    const counts = await this.text(projectId, [
      'rev-list',
      '--left-right',
      '--count',
      `${base.sha}...${head.sha}`,
    ]);
    const [behind, ahead] = counts.trim().split(/\s+/).map(Number);
    const log = await this.text(projectId, [
      'log',
      '-z',
      `--format=${COMMIT_FORMAT}`,
      `--max-count=${this.limits.maxCompareCommits}`,
      head.sha,
      `^${base.sha}`,
      '--',
    ]);
    return {
      base: base.ref,
      head: head.ref,
      baseSha: base.sha,
      headSha: head.sha,
      mergeBase,
      ahead: ahead ?? 0,
      behind: behind ?? 0,
      commits: parseCommitLog(log),
      diff: await this.diff(projectId, mergeBase ?? EMPTY_TREE, head.sha, options.paths),
    };
  }

  /** The ls-tree entry of `path` in commit `sha`, or null when the path does not exist there. */
  private async entryAt(projectId: string, sha: string, path: string) {
    assertRepoPath(path);
    const output = await this.text(projectId, [
      'ls-tree',
      '-z',
      '-l',
      '--full-tree',
      sha,
      '--',
      path,
    ]);
    return parseLsTree(output).find((entry) => entry.path === path) ?? null;
  }

  /** The entries of a directory at `ref`; the empty path is the repository root. */
  async tree(projectId: string, ref: string, path: string): Promise<TreeListing> {
    assertRepoPath(path);
    const resolved = await this.resolveRef(projectId, ref);
    let treeId = `${resolved.sha}^{tree}`;
    if (path !== '') {
      const entry = await this.entryAt(projectId, resolved.sha, path);
      if (!entry || entry.type !== 'tree') throw notFound(`Directory ${path}`);
      treeId = entry.oid;
    }
    const output = await this.text(projectId, ['ls-tree', '-z', '-l', treeId]);
    return { ...resolved, path, entries: toTreeEntries(parseLsTree(output), path) };
  }

  /** A file at `ref` as text, unless it is binary or larger than the viewer limit. */
  async file(projectId: string, ref: string, path: string): Promise<FileContent> {
    const resolved = await this.resolveRef(projectId, ref);
    const entry = await this.entryAt(projectId, resolved.sha, path);
    if (!entry || entry.type !== 'blob') throw notFound(`File ${path}`);
    const size = entry.size ?? 0;
    const tooLarge = size > this.limits.maxFileBytes;
    const { stdout } = await this.git.run(
      this.repoArgs(projectId, ['cat-file', 'blob', entry.oid]),
      {
        timeoutMs: this.limits.timeoutMs,
        maxBytes: tooLarge ? 8000 : this.limits.maxFileBytes,
        allowTruncate: tooLarge,
      },
    );
    const binary = looksBinary(stdout);
    return {
      ...resolved,
      path,
      size,
      binary,
      tooLarge,
      content: binary || tooLarge ? null : stdout.toString('utf8'),
    };
  }

  /**
   * The blob at `path` in `ref` for the raw route: its commit, object id and size. Files above the
   * raw limit are refused with 413 before any content is read.
   */
  async blob(
    projectId: string,
    ref: string,
    path: string,
  ): Promise<{ sha: string; oid: string; size: number }> {
    const resolved = await this.resolveRef(projectId, ref);
    const entry = await this.entryAt(projectId, resolved.sha, path);
    if (!entry || entry.type !== 'blob') throw notFound(`File ${path}`);
    const size = entry.size ?? 0;
    if (size > this.limits.maxRawBytes) {
      throw new AppError(
        413,
        'file_too_large',
        `The file is larger than ${this.limits.maxRawBytes} bytes`,
      );
    }
    return { sha: resolved.sha, oid: entry.oid, size };
  }

  /** The content of a blob found with `blob`. */
  async readBlob(projectId: string, oid: string): Promise<Buffer> {
    if (!OBJECT_ID.test(oid)) throw new Error('invalid object id');
    const { stdout } = await this.git.run(this.repoArgs(projectId, ['cat-file', 'blob', oid]), {
      timeoutMs: this.limits.timeoutMs,
      maxBytes: this.limits.maxRawBytes,
    });
    return stdout;
  }

  /** A ZIP of `ref` streamed from `git archive`, with every path under `prefix/`. */
  async archive(projectId: string, sha: string, prefix: string): Promise<Readable> {
    if (!OBJECT_ID.test(sha) || !/^[A-Za-z0-9._-]+$/.test(prefix)) {
      throw new Error('invalid archive arguments');
    }
    return this.git.stream(
      this.repoArgs(projectId, ['archive', '--format=zip', `--prefix=${prefix}/`, sha]),
      { timeoutMs: this.limits.archiveTimeoutMs, maxBytes: this.limits.archiveMaxBytes },
    );
  }
}
