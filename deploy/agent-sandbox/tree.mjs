import { constants } from 'node:fs';
import { chmod, chown, lchown, lstat, open, opendir, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

/** Upper bound of entries walked in one clone; a larger tree fails instead of running for hours. */
export const MAX_TREE_ENTRIES = 2_000_000;

export class TreeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TreeError';
  }
}

/** True when `child` lies strictly below `parent` (both absolute and normalised). */
export function isBelow(parent, child) {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Check that `path` lies below `root`, that `root` is its own real path and that no component
 * from `root` down to `path` is a symlink. The last component must be a directory. Returns the
 * stat of `path`. Nothing writes to these paths while the check runs (the unit has not started or
 * has ended), so the check is not raced by the agent.
 */
export async function assertRealDirectoryBelow(root, path) {
  if (!isAbsolute(root) || !isAbsolute(path)) throw new TreeError('paths must be absolute');
  if ((await realpath(root)) !== root) throw new TreeError(`${root} is not a real path`);
  if (!isBelow(root, path)) throw new TreeError(`${path} is not below ${root}`);
  let current = root;
  let info = await lstat(root);
  for (const part of relative(root, path).split(sep)) {
    current = join(current, part);
    info = await lstat(current);
    if (info.isSymbolicLink()) throw new TreeError(`${current} is a symlink`);
    if (!info.isDirectory()) throw new TreeError(`${current} is not a directory`);
  }
  if ((await realpath(path)) !== path) throw new TreeError(`${path} is not a real path`);
  return info;
}

/** lstat that returns null for an entry that disappeared, when `missingOk` is set. */
async function statOrSkip(path, missingOk) {
  try {
    return await lstat(path);
  } catch (error) {
    if (missingOk && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
    throw error;
  }
}

/** opendir that returns null for a directory that disappeared, when `missingOk` is set. */
async function openOrSkip(dir, missingOk) {
  try {
    return await opendir(dir);
  } catch (error) {
    if (missingOk && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
    throw error;
  }
}

/**
 * Visit every entry below `root` (and `root` itself) without following symlinks. With
 * `missingOk`, entries that vanish during the walk (a running install, build or git) are skipped.
 */
async function walk(root, visit, budget = MAX_TREE_ENTRIES, missingOk = false) {
  const pending = [root];
  let seen = 0;
  while (pending.length > 0) {
    const dir = pending.pop();
    const info = await statOrSkip(dir, missingOk && dir !== root);
    if (!info) continue;
    await visit(dir, info);
    seen += 1;
    if (!info.isDirectory()) continue;
    const entries = await openOrSkip(dir, missingOk && dir !== root);
    if (!entries) continue;
    for await (const entry of entries) {
      seen += 1;
      if (seen > budget) throw new TreeError(`more than ${budget} entries below ${root}`);
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      const child = await statOrSkip(path, missingOk);
      if (child) await visit(path, child);
    }
  }
}

/**
 * Mode bits after a run: directories 2770 (setgid keeps the shared group on new entries), files
 * read-write for owner and group, executable for both when the owner could execute, nothing for
 * others and never setuid or setgid.
 */
export function sharedMode(mode, isDirectory) {
  if (isDirectory) return 0o2770;
  return (mode & 0o100) !== 0 ? 0o770 : 0o660;
}

const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino;

/** Change owner and mode of a regular file through a descriptor opened without following links. */
async function chownFile(name, expected, uid, gid, mode) {
  const handle = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!sameInode(info, expected)) throw new TreeError(`${name} changed while it was handed over`);
    if (info.uid !== uid || info.gid !== gid) await handle.chown(uid, gid);
    if (mode !== null && (info.mode & 0o7777) !== mode) await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

/**
 * Give every entry below `root` to `uid:gid`. With `share`, directories and files get the modes
 * of sharedMode; without it, modes stay as they are. More than `budget` entries fail the walk;
 * pass Infinity where stopping halfway is worse (handing a clone back). Returns the number of
 * entries.
 *
 * Path strings are never resolved below `root`: the walk changes into each directory and checks
 * that `.` is the inode it found (so a directory swapped for a symlink is detected), then works
 * on single names only: lchown for symlinks, a descriptor opened with O_NOFOLLOW for files, `.`
 * for the directory itself. Other users who can write in the tree (the shared group) cannot
 * redirect it elsewhere.
 */
export async function chownTree(root, uid, gid, { share = false, budget = MAX_TREE_ENTRIES } = {}) {
  const previous = process.cwd();
  const pending = [{ path: root, expected: await lstat(root) }];
  const target = { uid, gid, share };
  let entries = 0;
  try {
    while (pending.length > 0) {
      const { path, expected } = pending.pop();
      await enterDirectory(path, expected, target);
      entries += 1;
      for (const name of await readdir('.')) {
        entries += 1;
        if (entries > budget) throw new TreeError(`more than ${budget} entries below ${root}`);
        const info = await lstat(name);
        if (info.isDirectory()) pending.push({ path: join(path, name), expected: info });
        else await handOver(name, info, target);
      }
    }
  } finally {
    process.chdir(previous);
  }
  return entries;
}

/** Change into `path`, check it is still the directory found earlier and hand it over. */
async function enterDirectory(path, expected, { uid, gid, share }) {
  process.chdir(path);
  const here = await lstat('.');
  if (!expected.isDirectory() || !sameInode(here, expected)) {
    throw new TreeError(`${path} changed while it was handed over`);
  }
  if (here.uid !== uid || here.gid !== gid) await chown('.', uid, gid);
  const mode = sharedMode(0, true);
  if (share && (here.mode & 0o7777) !== mode) await chmod('.', mode);
}

/** Hand over one non-directory entry of the current directory, by name. */
async function handOver(name, info, { uid, gid, share }) {
  if (info.isFile()) {
    await chownFile(name, info, uid, gid, share ? sharedMode(info.mode & 0o7777, false) : null);
  } else if (info.uid !== uid || info.gid !== gid) {
    await lchown(name, uid, gid);
  }
}

/**
 * Bytes allocated below `root` (st_blocks, like du), counting each hardlinked inode once. Entries
 * that disappear while the walk runs are skipped, so it works on a clone that is being written.
 */
export async function diskUsage(root) {
  const inodes = new Set();
  let bytes = 0;
  const visit = async (_path, info) => {
    if (info.nlink > 1) {
      const key = `${info.dev}:${info.ino}`;
      if (inodes.has(key)) return;
      inodes.add(key);
    }
    bytes += info.blocks * 512;
  };
  await walk(root, visit, MAX_TREE_ENTRIES, true);
  return bytes;
}
