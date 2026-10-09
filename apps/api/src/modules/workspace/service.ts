import { randomBytes } from 'node:crypto';
import { lstat, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_BRANCH,
  issueBranchName,
  type BranchSync,
  type IssueWorkspaceInfo,
} from '@conclavix/core';
import { conflict, notFound, unprocessable } from '../../errors.js';
import { GitError } from './git.js';
import {
  NO_REF,
  OBJECT_ID,
  exists,
  isMissing,
  mkdirShared,
  removeLeftovers,
  shareTree,
} from './repo-base.js';
import { RepoMerger } from './merge.js';

export { DEFAULT_LIMITS, type WorkspaceLimits, type ResolvedRef } from './repo-base.js';

/**
 * Project workspaces on the server: one bare repository per project at
 * `<root>/repos/<projectId>.git` and one separate clone per issue at
 * `<root>/workspaces/<projectId>/<issueKey>` on the branch `cvx/<issueKey>`. The bare repository
 * is never handed to agents; `syncIssueBranch` fetches the issue branch back into it, and every
 * read goes to the bare repository only.
 *
 * Every git call goes through `Git` (fixed argument arrays, no shell). Refs from requests are
 * checked with `git check-ref-format` and resolved to a full commit id before any other command
 * sees them; paths are looked up with `git ls-tree` inside the commit's tree, never on disk.
 */
/** Upper bound of entries checked in an issue clone's `.git` directory. */
const MAX_CLONE_ENTRIES = 200_000;

/**
 * The first entry below `root` that is not a directory or a regular file with one link, as a
 * path relative to `root`; null when every entry is safe. More than `budget` entries count as
 * unsafe.
 */
export async function findUnsafeEntry(root: string, budget: number): Promise<string | null> {
  const pending = [''];
  let seen = 0;
  while (pending.length > 0) {
    const relative = pending.pop() ?? '';
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      seen += 1;
      if (seen > budget) return `more than ${budget} entries`;
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile()) return path;
      if ((await lstat(join(root, path))).nlink !== 1) return path;
    }
  }
  return null;
}

export class Workspace extends RepoMerger {
  /**
   * The `.git` directory of an issue clone, checked before the server reads from it: a real
   * directory (no symlink, no gitfile) without `commondir` or object alternates, holding only
   * directories and regular files with a single link (no symlinks, hardlinks, FIFOs or devices
   * anywhere inside), so a clone cannot point the server at another repository's files.
   */
  protected async cloneGitDir(projectId: string, issueKey: string): Promise<string> {
    const gitDir = join(this.issueWorkspaceDir(projectId, issueKey), '.git');
    let info;
    try {
      info = await lstat(gitDir);
    } catch (error) {
      if (isMissing(error)) throw notFound(`Workspace of ${issueKey}`);
      throw error;
    }
    if (!info.isDirectory()) {
      throw unprocessable(`The workspace of ${issueKey} has no plain .git directory`);
    }
    for (const redirect of ['commondir', join('objects', 'info', 'alternates')]) {
      if (await exists(join(gitDir, redirect))) {
        throw unprocessable(`The workspace of ${issueKey} refers to another repository`);
      }
    }
    const problem = await findUnsafeEntry(gitDir, MAX_CLONE_ENTRIES);
    if (problem) {
      throw unprocessable(`The workspace of ${issueKey} has an unsafe .git entry`, { problem });
    }
    return gitDir;
  }

  /**
   * Run `fn` with an environment whose global git configuration only marks `path` as a safe
   * directory. `git upload-pack` (local clone, fetch, ls-remote) reads the repository it serves
   * without the command-line configuration and refuses one owned by another user, and the
   * minimal git environment ignores the system and user configuration, so the mark goes into a
   * temporary global configuration file holding nothing else.
   */
  protected async withSafeDirectory<T>(
    path: string,
    fn: (env: Record<string, string>) => Promise<T>,
  ): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'cvx-git-'));
    try {
      const config = join(dir, 'config');
      const quoted = path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      await writeFile(config, `[safe]\n\tdirectory = "${quoted}"\n`, { mode: 0o600 });
      return await fn({ GIT_CONFIG_GLOBAL: config });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Run git on the bare repository's side against an issue clone. The local transport is allowed
   * for this call only and incoming objects are checked. The clone may belong to the agent user,
   * so it is marked as a safe directory.
   */
  protected async fromClone(projectId: string, gitDir: string, args: readonly string[]) {
    return this.withSafeDirectory(gitDir, (env) =>
      this.git.run(
        [
          '-c',
          'protocol.file.allow=always',
          '-c',
          'transfer.fsckObjects=true',
          '-c',
          'core.sshCommand=/bin/false',
          ...this.repoArgs(projectId, args),
        ],
        { timeoutMs: this.limits.archiveTimeoutMs, env },
      ),
    );
  }

  /** The tip of the issue branch inside the clone, read with `ls-remote` from the bare side. */
  private async cloneHead(projectId: string, issueKey: string, gitDir: string) {
    const ref = `refs/heads/${issueBranchName(issueKey)}`;
    const { stdout } = await this.fromClone(projectId, gitDir, [
      'ls-remote',
      '--heads',
      gitDir,
      ref,
    ]);
    const line = stdout
      .toString('utf8')
      .split('\n')
      .find((entry) => entry.endsWith(`\t${ref}`));
    const sha = line?.split('\t')[0] ?? '';
    return OBJECT_ID.test(sha) ? sha : null;
  }

  /** Every ref of the clone (HEAD, branches, tags, stash) with its object id, read from the bare side. */
  private async cloneRefs(projectId: string, gitDir: string): Promise<Map<string, string>> {
    const { stdout } = await this.fromClone(projectId, gitDir, ['ls-remote', gitDir]);
    const refs = new Map<string, string>();
    for (const line of stdout.toString('utf8').split('\n')) {
      const [sha = '', name = ''] = line.split('\t');
      if (OBJECT_ID.test(sha) && name) refs.set(name, sha);
    }
    return refs;
  }

  /**
   * Refs of the clone whose commits the bare repository lacks: the object is missing there, or it
   * is not reachable from any server ref. A clone without its issue branch counts as unsynced.
   */
  private async unsyncedRefs(
    projectId: string,
    issueKey: string,
    gitDir: string,
  ): Promise<string[]> {
    const refs = await this.cloneRefs(projectId, gitDir);
    const branchRef = `refs/heads/${issueBranchName(issueKey)}`;
    const unsynced = refs.has(branchRef) ? [] : [branchRef];
    for (const [name, sha] of refs) {
      const known = await this.commitOf(projectId, sha);
      if (!known) {
        unsynced.push(name);
        continue;
      }
      const ahead = await this.text(projectId, ['rev-list', '-n', '1', known, '--not', '--all']);
      if (ahead.trim() !== '') unsynced.push(name);
    }
    return unsynced;
  }

  /**
   * An id of the clone directory that stays the same while the clone exists and changes when it
   * is removed and created again (inode and birth time).
   */
  private async cloneId(dir: string): Promise<string> {
    const info = await stat(dir, { bigint: true });
    return `${info.ino.toString(16)}-${info.birthtimeNs.toString(16)}`;
  }

  /**
   * Clone `branch` of the bare repository into `temp` without hardlinks, tags or a remote, and
   * return the tip the clone holds (the server branch may move right after the clone).
   */
  private async cloneBranch(projectId: string, branch: string, temp: string): Promise<string> {
    // The bare repository belongs to the API user; the runner clones it as another user.
    await this.withSafeDirectory(this.repoDir(projectId), (env) =>
      this.git.run(
        [
          '-c',
          'protocol.file.allow=always',
          'clone',
          '--quiet',
          '--no-hardlinks',
          '--single-branch',
          '--no-tags',
          `--branch=${branch}`,
          this.repoDir(projectId),
          temp,
        ],
        { timeoutMs: this.limits.archiveTimeoutMs, env },
      ),
    );
    const gitDir = `--git-dir=${join(temp, '.git')}`;
    const options = { timeoutMs: this.limits.timeoutMs };
    await this.git.run([gitDir, 'remote', 'remove', 'origin'], options);
    const tip = await this.git.text(
      [gitDir, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`],
      options,
    );
    if (!OBJECT_ID.test(tip)) throw new Error('the new clone has no branch tip');
    return tip;
  }

  /**
   * Create the workspace of an issue: the branch `cvx/<issueKey>` in the bare repository (cut
   * from main unless it exists) and a separate clone of it with `--no-hardlinks` and without a
   * remote. An existing clone is returned as it is.
   */
  async createIssueWorkspace(projectId: string, issueKey: string): Promise<IssueWorkspaceInfo> {
    const dir = this.issueWorkspaceDir(projectId, issueKey);
    const branch = await this.assertBranchName(issueBranchName(issueKey));
    await this.ensureRepo(projectId);
    return this.queue.run(`workspace:${projectId}:${issueKey}`, async () => {
      if (await exists(dir)) {
        const gitDir = await this.cloneGitDir(projectId, issueKey);
        const head = await this.cloneHead(projectId, issueKey, gitDir);
        return {
          issueKey,
          branch,
          head: head ?? '',
          created: false,
          cloneId: await this.cloneId(dir),
        };
      }
      const main = await this.resolveRef(projectId, DEFAULT_BRANCH);
      const branchRef = `refs/heads/${branch}`;
      if (!(await this.commitOf(projectId, branchRef))) {
        try {
          await this.run(projectId, ['update-ref', branchRef, main.sha, NO_REF]);
        } catch (error) {
          if (!(await this.commitOf(projectId, branchRef))) throw error;
        }
      }
      const parent = join(this.root, 'workspaces', projectId);
      await mkdirShared(parent);
      await removeLeftovers(parent, `.clone-${issueKey}-`);
      const temp = join(parent, `.clone-${issueKey}-${randomBytes(6).toString('hex')}`);
      let cloned: string;
      try {
        cloned = await this.cloneBranch(projectId, branch, temp);
        await shareTree(temp);
        await rename(temp, dir);
      } catch (error) {
        await rm(temp, { recursive: true, force: true });
        const code = (error as NodeJS.ErrnoException).code;
        // The other process (API or runner) created the clone first: use that one.
        if ((code === 'ENOTEMPTY' || code === 'EEXIST') && (await exists(dir))) {
          const gitDir = await this.cloneGitDir(projectId, issueKey);
          const head = await this.cloneHead(projectId, issueKey, gitDir);
          return {
            issueKey,
            branch,
            head: head ?? '',
            created: false,
            cloneId: await this.cloneId(dir),
          };
        }
        throw error;
      }
      return {
        issueKey,
        branch,
        head: cloned,
        created: true,
        cloneId: await this.cloneId(dir),
      };
    });
  }

  /**
   * Bring the issue branch from its clone into the bare repository: fetch only
   * `refs/heads/cvx/<issueKey>`, fast-forward only unless `force` is set. Returns the tips
   * before and after.
   */
  async syncIssueBranch(projectId: string, issueKey: string, force: boolean): Promise<BranchSync> {
    const branch = await this.assertBranchName(issueBranchName(issueKey));
    await this.ensureRepo(projectId);
    return this.queue.run(`workspace:${projectId}:${issueKey}`, async () => {
      const gitDir = await this.cloneGitDir(projectId, issueKey);
      const ref = `refs/heads/${branch}`;
      const before = await this.commitOf(projectId, ref);
      const cloneTip = await this.cloneHead(projectId, issueKey, gitDir);
      if (!cloneTip) throw notFound(`Branch ${branch} in the workspace of ${issueKey}`);
      try {
        await this.fromClone(projectId, gitDir, [
          'fetch',
          '--no-tags',
          '--no-write-fetch-head',
          '--no-recurse-submodules',
          '--no-auto-gc',
          gitDir,
          `${force ? '+' : ''}${ref}:${ref}`,
        ]);
      } catch (error) {
        if (!force && error instanceof GitError && /non-fast-forward|rejected/.test(error.stderr)) {
          throw conflict(`${branch} in the workspace is not a fast-forward of the server branch`, {
            hint: 'the server branch has commits the workspace lacks (for example an integration merge); the next coding run merges them, while forcing the update drops them',
          });
        }
        throw error;
      }
      const after = await this.commitOf(projectId, ref);
      return {
        issueKey,
        branch,
        before,
        after: after ?? '',
        updated: before !== after,
        forced: force,
      };
    });
  }

  /**
   * Remove the clone of an issue; its branch in the bare repository stays. Any ref of the clone
   * (HEAD, any branch, tag or stash) holding commits the bare repository lacks makes this a 409
   * unless `force` is set. Uncommitted files are not inspected (that would run git inside the
   * clone) and are always discarded.
   */
  async removeIssueWorkspace(projectId: string, issueKey: string, force: boolean): Promise<void> {
    const dir = this.issueWorkspaceDir(projectId, issueKey);
    await this.ensureRepo(projectId);
    await this.queue.run(`workspace:${projectId}:${issueKey}`, async () => {
      if (!(await exists(dir))) throw notFound(`Workspace of ${issueKey}`);
      if (!force) {
        const gitDir = await this.cloneGitDir(projectId, issueKey);
        const unsynced = await this.unsyncedRefs(projectId, issueKey, gitDir);
        if (unsynced.length > 0) {
          throw conflict(`The workspace of ${issueKey} has work the server lacks`, {
            refs: unsynced.slice(0, 20),
            hint: 'sync the branch first, or pass force=true to discard it',
          });
        }
      }
      await rm(dir, { recursive: true, force: true });
    });
  }
}
