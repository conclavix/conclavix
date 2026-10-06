import { constants } from 'node:fs';
import { lstat, open, readdir, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isMissing } from './repo-base.js';

/**
 * Entries Claude Code's Bash sandbox leaves in the `.git` of its working directory. Before it
 * starts bubblewrap it creates the git paths it wants to protect, so they can be mounted
 * read-only (an empty `config.worktree`), and bubblewrap creates the mount points of paths that
 * did not exist (empty files or directories); they stay behind when the unit has ended. None of
 * them in these shapes changes what git reads: an empty or "." `commondir` names the git
 * directory itself.
 */
export const SANDBOX_PLACEHOLDERS = [
  'commondir',
  'config.worktree',
  'worktrees',
  'modules',
  'glab-cli',
] as const;

/** Contents of a placeholder file that are removed; anything else stays for the checks. */
const HARMLESS_CONTENT: Record<string, readonly string[]> = {
  commondir: ['', '.', '.\n'],
};

/** Larger files are never placeholders, so they are not read. */
const MAX_PLACEHOLDER_BYTES = 8;

/**
 * Remove the sandbox placeholders from `gitDir` and return their names. Only the names in
 * SANDBOX_PLACEHOLDERS directly inside `gitDir` are looked at, and only an empty directory or a
 * regular file with one link and harmless content (empty, or "." for `commondir`) is removed;
 * symlinks, hardlinks, non-empty directories and every other content are left in place, so the
 * checks of `cloneGitDir` that follow still reject them. Call it only while nothing runs in the
 * clone (no sandbox unit); `gitDir` must be a real directory, which `cloneGitDir` verifies.
 */
export async function removeSandboxPlaceholders(gitDir: string): Promise<string[]> {
  const removed: string[] = [];
  for (const name of SANDBOX_PLACEHOLDERS) {
    const path = join(gitDir, name);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (info.isDirectory()) {
      if ((await readdir(path)).length > 0) continue;
      await rmdir(path);
      removed.push(name);
    } else if (info.isFile() && info.nlink === 1 && info.size <= MAX_PLACEHOLDER_BYTES) {
      const content = await readNoFollow(path, info);
      if (content === null || !(HARMLESS_CONTENT[name] ?? ['']).includes(content)) continue;
      await unlink(path);
      removed.push(name);
    }
  }
  return removed;
}

/**
 * The content of a small regular file read without following a symlink; null when the entry
 * is no longer the one `expected` describes.
 */
async function readNoFollow(
  path: string,
  expected: { dev: number; ino: number },
): Promise<string | null> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.dev !== expected.dev || info.ino !== expected.ino) return null;
    if (info.nlink !== 1 || info.size > MAX_PLACEHOLDER_BYTES) return null;
    const buffer = Buffer.alloc(MAX_PLACEHOLDER_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_PLACEHOLDER_BYTES) return null;
    return buffer.subarray(0, bytesRead).toString('latin1');
  } finally {
    await handle.close();
  }
}
