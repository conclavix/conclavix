import { DEFAULT_BRANCH, issueBranchName } from '@conclavix/core';
import { AppError } from '../../errors.js';
import { cleanMessage, oneLine, type CommitIdentity } from './identity.js';
import { RepoMerger, type BranchMerge, type MergeStatus } from './merge.js';
import type { ResolvedRef } from './repo-base.js';

/** Characters of a squash commit subject (its first line). */
export const MAX_SQUASH_SUBJECT = 100;
/** Directory prefixes one squash may be limited to. */
export const MAX_SQUASH_PATHS = 20;
/** Top-level entries and out-of-scope paths listed in one answer. */
const MAX_LISTED = 50;

/** Identity of the throwaway commits a squash preview writes; they are never referenced. */
const PREVIEW_IDENTITY: CommitIdentity = { name: 'Conclavix', email: 'preview@conclavix.invalid' };

/** What a squash changes against the commit it starts from. */
export interface ChangeSummary {
  /** Changed files (added, modified or deleted). */
  files: number;
  /** Distinct first path segments of the changed files, sorted, at most MAX_LISTED. */
  topLevel: string[];
  moreTopLevel: number;
}

export interface SquashMerge extends BranchMerge {
  squash: true;
  /** The squash commit, or null when the sources changed nothing. */
  commit: string | null;
  changes: ChangeSummary;
}

export interface SquashPreview {
  /** All sources merge onto the target, one after the other, without a conflict. */
  clean: boolean;
  /** The first source that conflicts with the line merged so far. */
  conflictSource: string | null;
  changes: ChangeSummary | null;
}

export type SquashMergeStatus = MergeStatus & { squash?: SquashPreview };

const invalidMessage = (text: string): AppError => new AppError(400, 'invalid_message', text);

/**
 * The message of a squash commit: the caller's subject and optional body, then the server's
 * trailers. The subject is the first line, non-empty and at most MAX_SQUASH_SUBJECT characters;
 * `Conclavix-*` trailer lines are refused, since only the server writes them.
 */
export function squashMessage(message: string, trailers: readonly string[] = []): string {
  const [first = '', ...rest] = message.replace(/\r\n?/g, '\n').split('\n');
  const subject = oneLine(first);
  const body = cleanMessage(rest.join('\n'));
  if (subject === '') throw invalidMessage('a squash needs a message with a subject line');
  if (subject.length > MAX_SQUASH_SUBJECT) {
    throw invalidMessage(`the subject line has more than ${MAX_SQUASH_SUBJECT} characters`);
  }
  if ([subject, ...body.split('\n')].some((line) => /^\s*conclavix-[\w-]*\s*:/i.test(line))) {
    throw invalidMessage('Conclavix-* trailers are added by the server; leave them out');
  }
  const lines = trailers.map(oneLine).filter((line) => line !== '');
  return `${[subject, body, lines.join('\n')].filter((part) => part !== '').join('\n\n')}\n`;
}

/**
 * Normalize directory prefixes: relative, `/`-separated, no `.` or `..` segments, no trailing
 * slash. Throws 400 `invalid_paths` otherwise.
 */
export function scopePaths(paths: readonly string[]): string[] {
  if (paths.length === 0 || paths.length > MAX_SQUASH_PATHS) {
    throw new AppError(400, 'invalid_paths', `name 1 to ${MAX_SQUASH_PATHS} directory prefixes`);
  }
  return paths.map((raw) => {
    const path = raw.replace(/\/+$/, '');
    const segments = path.split('/');
    const bad =
      path === '' ||
      raw.startsWith('/') ||
      /[\\\p{Cc}]/u.test(path) ||
      segments.some((segment) => segment === '' || segment === '.' || segment === '..');
    if (bad) throw new AppError(400, 'invalid_paths', `not a relative directory prefix: ${raw}`);
    return path;
  });
}

/** Changed paths outside every prefix. */
export function outsidePaths(changed: readonly string[], prefixes: readonly string[]): string[] {
  return changed.filter(
    (path) => !prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)),
  );
}

/** Count and top-level directories of changed paths. */
export function summarizeChanges(changed: readonly string[]): ChangeSummary {
  const top = [...new Set(changed.map((path) => path.split('/')[0] as string))].sort();
  return {
    files: changed.length,
    topLevel: top.slice(0, MAX_LISTED),
    moreTopLevel: Math.max(0, top.length - MAX_LISTED),
  };
}

/**
 * Squash merges: the sources merged as by mergeIntoIssueBranch, but the target receives one new
 * commit on its current tip whose tree is the result of all those merges, without the sources as
 * parents. The intermediate merge commits are computed and left unreferenced.
 */
export class RepoSquasher extends RepoMerger {
  /** Files that differ between two commits, renames as deletion plus addition. */
  protected async changedPaths(projectId: string, from: string, to: string): Promise<string[]> {
    const output = await this.text(projectId, [
      'diff-tree',
      '-r',
      '-z',
      '--no-renames',
      '--name-only',
      from,
      to,
    ]);
    return output.split('\0').filter((path) => path !== '');
  }

  /** The tree id of a commit. */
  protected async treeOf(projectId: string, commit: string): Promise<string> {
    return (await this.text(projectId, ['rev-parse', `${commit}^{tree}`])).trim();
  }

  /**
   * Squash `sources` into `cvx/<issueKey>`: one commit by `author` with `message` (see
   * squashMessage) and `trailers`, whose parent is the current tip (or `base` for a new branch).
   * With `paths`, a change outside these directory prefixes is refused with 409 `out_of_scope`.
   * Conflicts are refused like mergeIntoIssueBranch; a refused call changes no ref.
   */
  async squashIntoIssueBranch(
    projectId: string,
    issueKey: string,
    input: {
      sources: readonly string[];
      base?: string;
      message: string;
      paths?: readonly string[];
      author: CommitIdentity;
      trailers?: readonly string[];
    },
  ): Promise<SquashMerge> {
    const target = await this.assertBranchName(issueBranchName(issueKey));
    const message = squashMessage(input.message, input.trailers);
    const prefixes = input.paths ? scopePaths(input.paths) : null;
    await this.ensureRepo(projectId);
    return this.queue.run(`workspace:${projectId}:${issueKey}`, async () => {
      const tips = await this.sourceTips(projectId, target, input.sources);
      const before = await this.commitOf(projectId, `refs/heads/${target}`);
      const startedFrom: ResolvedRef = before
        ? { ref: target, sha: before }
        : await this.resolveReachable(projectId, input.base ?? DEFAULT_BRANCH);
      const start = startedFrom.sha;
      const chain = await this.mergeChain(projectId, target, start, tips, {
        author: input.author,
        message: (source) => `Squash step '${source}' into ${target}`,
      });
      const changed = await this.changedPaths(projectId, start, chain.current);
      const outside = prefixes ? outsidePaths(changed, prefixes) : [];
      if (prefixes && outside.length > 0) {
        throw new AppError(
          409,
          'out_of_scope',
          `the squash changes files outside ${prefixes.join(', ')}`,
          {
            target,
            paths: prefixes,
            outside: outside.slice(0, MAX_LISTED),
            moreOutside: Math.max(0, outside.length - MAX_LISTED),
            hint: 'nothing was changed; remove those changes from the sources or widen paths',
          },
        );
      }
      const commit =
        changed.length === 0
          ? null
          : await this.writeCommit(
              projectId,
              await this.treeOf(projectId, chain.current),
              [start],
              message,
              input.author,
            );
      const after = commit ?? start;
      if (before !== after) await this.moveBranch(projectId, target, after, before);
      return {
        target,
        status: commit ? 'merged' : 'up_to_date',
        created: before === null,
        startedFrom,
        before,
        after,
        merges: chain.merges.map((step) => ({ ...step, commit: step.commit ? commit : null })),
        squash: true,
        commit,
        changes: summarizeChanges(changed),
      };
    });
  }

  /**
   * mergeStatus, and with `squash` also what a squash of all sources onto the target would
   * change. The preview writes unreferenced objects only.
   */
  override async mergeStatus(
    projectId: string,
    target: string,
    sources: readonly string[],
    base: string = DEFAULT_BRANCH,
    options: { squash?: boolean } = {},
  ): Promise<SquashMergeStatus> {
    const status: SquashMergeStatus = await super.mergeStatus(projectId, target, sources, base);
    if (!options.squash || sources.length === 0) return status;
    const start = status.tip ?? (await this.resolveReachable(projectId, base)).sha;
    const tips = status.sources.map(({ source, sha }) => ({ source, sha }));
    try {
      const chain = await this.mergeChain(projectId, target, start, tips, {
        author: PREVIEW_IDENTITY,
        message: (source) => `Squash preview '${source}'`,
      });
      const changes = summarizeChanges(await this.changedPaths(projectId, start, chain.current));
      status.squash = { clean: true, conflictSource: null, changes };
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'merge_conflict') throw error;
      const source = (error.details as { source?: string } | undefined)?.source ?? null;
      status.squash = { clean: false, conflictSource: source, changes: null };
    }
    return status;
  }
}
