import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { CloneGit } from './clone-git.js';
import { oneLine } from './identity.js';
import { exists, isMissing } from './repo-base.js';

/**
 * The HEAD guard of coding runs. The runner commits whatever the work tree holds after a run, on
 * the branch tip it prepared. An agent that moved HEAD itself (`git reset`, `checkout`, `rebase`)
 * leaves a work tree that belongs to another commit; committing it would record the difference as
 * the run's change (reverted files, a squash on the wrong base). The guard notes the clone's state
 * when the run starts and refuses the commit when it changed in a way only such commands cause.
 * It catches mistakes; it is no security boundary (the agent can write `.git`), the server side
 * stays one: the sync is fast-forward only and the server branch is never rewritten by a run.
 */

/** The clone's state the run starts from. */
export interface CloneHead {
  /** The tip of the issue branch in the clone. */
  tip: string;
  /** Byte sizes of the reflogs of HEAD and of the issue branch. */
  logs: { head: number; branch: number };
}

/** Reflog bytes a run may add before the guard stops reading and refuses. */
const MAX_REFLOG_BYTES = 256 * 1024;
/** Operations whose state files in `.git` mean they were left half done. */
const IN_PROGRESS = [
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'rebase-merge',
  'rebase-apply',
] as const;
/** `<old> <new> <ident> <time> <zone>\t<message>`, one reflog line. */
const REFLOG_LINE = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) [^\t]*\t?(.*)$/;
/** Reflog messages of commits, which may move HEAD forward. */
const COMMIT_MESSAGE = /^commit( \([a-z]+\))?:/;
const MAX_REPORTED = 5;

const reflogPath = (gitDir: string, ref: string): string => join(gitDir, 'logs', ...ref.split('/'));

/** Read a regular file from `offset` (at most `max` bytes) without following a symlink. */
async function readFrom(
  path: string,
  offset: number,
  max: number,
): Promise<{ size: number; text: string } | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${path} is not a regular file`);
    const length = Math.max(0, Math.min(info.size - offset, max));
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, offset);
    return { size: info.size, text: buffer.toString('utf8') };
  } finally {
    await handle.close();
  }
}

const sizeOf = async (path: string): Promise<number> => (await readFrom(path, 0, 0))?.size ?? 0;

/** Note the state of a clone whose branch `ref` is checked out, right before a run. */
export async function captureCloneHead(
  git: CloneGit,
  gitDir: string,
  ref: string,
): Promise<CloneHead> {
  const tip = await git.commit(ref);
  if (!tip) throw new Error(`${ref} is missing in the workspace`);
  return {
    tip,
    logs: {
      head: await sizeOf(join(gitDir, 'logs', 'HEAD')),
      branch: await sizeOf(reflogPath(gitDir, ref)),
    },
  };
}

/** Moves recorded in a reflog since `offset` that only git commands other than commit make. */
async function reflogMoves(path: string, offset: number, what: string): Promise<string[]> {
  const read = await readFrom(path, offset, MAX_REFLOG_BYTES);
  if (!read) return offset > 0 ? [`the reflog of ${what} was removed`] : [];
  if (read.size < offset) return [`the reflog of ${what} was shortened`];
  if (read.size - offset > MAX_REFLOG_BYTES) return [`${what} was updated too often to check`];
  const moves: string[] = [];
  for (const line of read.text.split('\n')) {
    const match = REFLOG_LINE.exec(line);
    if (!match || match[1] === match[2]) continue;
    const message = oneLine(match[3] ?? '').slice(0, 120);
    if (!COMMIT_MESSAGE.test(message)) moves.push(`${what} moved (${message || 'no message'})`);
  }
  return moves;
}

/**
 * What changed in the clone since `start` that the runner must not commit over, or an empty
 * list: HEAD no longer on `ref`, the branch no longer containing the start tip, a reflog entry of
 * HEAD or the branch that is not a commit (reset, checkout, rebase, merge, pull, update-ref), an
 * operation left in progress, or unmerged index entries. Commits the agent added on top of the
 * start tip pass. A check that fails counts as a problem.
 */
export async function checkCloneHead(
  git: CloneGit,
  gitDir: string,
  ref: string,
  start: CloneHead,
): Promise<string[]> {
  const problems: string[] = [];
  const head = (await git.run(['symbolic-ref', '-q', 'HEAD'], { allowExitCodes: [1] })).stdout
    .toString('utf8')
    .trim();
  if (head !== ref) problems.push(head ? `HEAD is on ${head}` : 'HEAD is detached');
  const tip = await git.commit(ref);
  if (!tip) problems.push(`${ref} was deleted`);
  else if (!(await git.isAncestor(start.tip, tip).catch(() => false))) {
    problems.push(`${ref} moved from ${start.tip.slice(0, 12)} to ${tip.slice(0, 12)}`);
  }
  problems.push(
    ...(await reflogMoves(join(gitDir, 'logs', 'HEAD'), start.logs.head, 'HEAD')),
    ...(await reflogMoves(reflogPath(gitDir, ref), start.logs.branch, ref)),
  );
  for (const name of IN_PROGRESS) {
    if (await exists(join(gitDir, name)))
      problems.push(`a git operation was left in progress (${name})`);
  }
  const unmerged = await git
    .text(['ls-files', '--unmerged', '-z'], { maxBytes: 4096, allowTruncate: true })
    .catch(() => 'unreadable');
  if (unmerged !== '') problems.push('the index has unmerged or unreadable entries');
  return [...new Set(problems)].slice(0, MAX_REPORTED);
}
