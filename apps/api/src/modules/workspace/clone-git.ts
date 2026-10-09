import { randomBytes } from 'node:crypto';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AppError, conflict } from '../../errors.js';
import { GitError, type Git, type GitCallOptions } from './git.js';
import { safeIdent, type CommitIdentity } from './identity.js';
import { OBJECT_ID } from './repo-base.js';

/**
 * Git inside an issue clone, for the runner only (the API never runs git in a clone). Callers
 * check the clone's `.git` first and replace its configuration with CLONE_CONFIG.
 */

/**
 * The only configuration an issue clone keeps when the runner commits in it; whatever an agent
 * wrote to `.git/config` (filters, includes, fsmonitor, hooks path, worktree) is replaced. No
 * automatic gc: it could expire reflog entries during a run, which the HEAD guard reads.
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
  '[gc]',
  '\tauto = 0',
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

export async function resetCloneConfig(gitDir: string): Promise<void> {
  const temp = join(gitDir, `config.cvx-${randomBytes(6).toString('hex')}`);
  await writeFile(temp, CLONE_CONFIG, { mode: 0o660, flag: 'wx' });
  await rename(temp, join(gitDir, 'config'));
}

export interface CloneGit {
  run(args: readonly string[], extra?: GitCallOptions): ReturnType<Git['run']>;
  text(args: readonly string[], extra?: GitCallOptions): Promise<string>;
  /** The commit a revision names in the clone, or null. */
  commit(revision: string): Promise<string | null>;
  /** Whether `ancestor` is reachable from `descendant` (a commit counts as its own ancestor). */
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
}

/** git with the clone as git directory and work tree, and the clone's commit lookup. */
export function cloneGit(git: Git, gitDir: string, timeoutMs: number): CloneGit {
  const base = [`--git-dir=${gitDir}`, `--work-tree=${dirname(gitDir)}`];
  const options = (extra: GitCallOptions = {}): GitCallOptions => ({
    timeoutMs,
    cwd: dirname(gitDir),
    ...extra,
  });
  const run = (args: readonly string[], extra?: GitCallOptions) =>
    git.run([...base, ...args], options(extra));
  const text = (args: readonly string[], extra?: GitCallOptions) =>
    git.text([...base, ...args], options(extra));
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
  const isAncestor = async (ancestor: string, descendant: string): Promise<boolean> => {
    const { exitCode } = await run(['merge-base', '--is-ancestor', ancestor, descendant], {
      allowExitCodes: [1],
    });
    return exitCode === 0;
  };
  return { run, text, commit, isAncestor };
}

/** Run `work` with a temporary file listing DEFAULT_EXCLUDES, for `core.excludesFile`. */
async function withExcludes<T>(work: (excludeFile: string) => Promise<T>): Promise<T> {
  const excludes = await mkdtemp(join(tmpdir(), 'cvx-commit-'));
  try {
    const excludeFile = join(excludes, 'exclude');
    await writeFile(excludeFile, `${DEFAULT_EXCLUDES.join('\n')}\n`, { mode: 0o600 });
    return await work(excludeFile);
  } finally {
    await rm(excludes, { recursive: true, force: true });
  }
}

/**
 * The tree of the clone's work tree as the runner commits it: `parent` read into the index file
 * `index`, then every change added except DEFAULT_EXCLUDES and the clone's ignores.
 */
export async function snapshotWorkTree(
  git: CloneGit,
  index: string,
  parent: string,
): Promise<string> {
  return withExcludes(async (excludeFile) => {
    const env = { GIT_INDEX_FILE: index };
    await git.run(['read-tree', parent], { env });
    await git.run(['-c', `core.excludesFile=${excludeFile}`, 'add', '-A', '--', '.'], { env });
    return (await git.text(['write-tree'], { env })).trim();
  });
}

/**
 * Whether the work tree differs from `tip`: changed or deleted tracked files, or untracked files
 * that are neither ignored nor in DEFAULT_EXCLUDES. Reads the files but writes no objects, so it
 * stays cheap and safe on a clone a run left over its disk limit.
 */
export async function hasUncommittedWork(
  git: CloneGit,
  index: string,
  tip: string,
): Promise<boolean> {
  const env = { GIT_INDEX_FILE: index };
  await git.run(['read-tree', tip], { env });
  await git.run(['update-index', '-q', '--refresh'], { env, allowExitCodes: [1] });
  const tracked = await git.run(['diff-files', '--quiet'], { env, allowExitCodes: [1] });
  if (tracked.exitCode !== 0) return true;
  const untracked = await withExcludes((excludeFile) =>
    git.text(
      [
        '-c',
        `core.excludesFile=${excludeFile}`,
        'ls-files',
        '--others',
        '--exclude-standard',
        '--directory',
        '--no-empty-directory',
        '-z',
      ],
      { env, maxBytes: 64 * 1024, allowTruncate: true },
    ),
  );
  return untracked !== '';
}

/** Write a commit of `tree` on `parent` in the clone with a fixed author and committer. */
export async function commitTree(
  git: CloneGit,
  tree: string,
  parent: string,
  author: CommitIdentity,
  message: string,
): Promise<string> {
  const name = safeIdent(author.name, 'Conclavix');
  const email = safeIdent(author.email, 'conclavix@localhost');
  const sha = await git.text(['commit-tree', tree, '-p', parent, '-F', '-'], {
    input: message,
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

/**
 * Move the clone's branch `ref` from `from` to `to` and update the work tree. Without `force` this
 * is git's two-tree checkout, which refuses (409) to overwrite uncommitted changes and untracked
 * files that are not ignored; with `force` the tracked files become `to` exactly. A fresh index is built and moved into place.
 */
export async function checkoutClone(
  git: CloneGit,
  gitDir: string,
  ref: string,
  move: { from: string; to: string; force: boolean },
): Promise<void> {
  const { from, to, force } = move;
  const index = join(gitDir, `cvx-index-${randomBytes(6).toString('hex')}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await git.run(['read-tree', from], { env });
    if (force) {
      await git.run(['read-tree', '--reset', '-u', to], { env });
    } else {
      await git.run(['update-index', '-q', '--refresh'], { env, allowExitCodes: [1] });
      try {
        // Ignored files (build output, DEFAULT_EXCLUDES) may be overwritten, others not.
        await withExcludes((excludeFile) =>
          git.run(
            [
              '-c',
              `core.excludesFile=${excludeFile}`,
              'read-tree',
              '-m',
              '-u',
              '--exclude-per-directory=.gitignore',
              from,
              to,
            ],
            { env },
          ),
        );
      } catch (error) {
        if (error instanceof GitError && error.reason === 'exit') {
          throw conflict(
            `the workspace of ${ref.slice('refs/heads/'.length)} has changes that the server branch would overwrite`,
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

/**
 * Remove a temporary ref. A failure does not fail the reconciliation (the next one overwrites the
 * ref with `+` and removes it again) but is reported in `warnings`, which the runner records as a
 * run event.
 */
export async function dropRef(
  warnings: string[],
  name: string,
  remove: () => Promise<unknown>,
): Promise<void> {
  try {
    await remove();
  } catch (error) {
    warnings.push(`removing the temporary ref ${name} failed: ${(error as Error).message}`);
  }
}

/** Add the cleanup warnings to the message of the error that ended a reconciliation. */
export function withWarnings(error: unknown, warnings: string[]): unknown {
  if (warnings.length > 0 && error instanceof Error) {
    error.message = `${error.message} (${warnings.join('; ')})`;
  }
  return error;
}

/** Fast-forward checkout of the clone; false when it would overwrite files in the work tree. */
export async function checkedOut(
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
