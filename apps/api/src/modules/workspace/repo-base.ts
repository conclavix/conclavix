import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { DEFAULT_BRANCH, MAX_RAW_BYTES, issueKeySchema, repoPathSchema } from '@conclavix/core';
import { AppError, notFound } from '../../errors.js';
import { Git, GitError } from './git.js';
import { DEFAULT_AGENT_EMAIL_DOMAIN } from './identity.js';

/** Git's well-known empty tree; it exists in every SHA-1 repository without being stored. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MIN_GIT_MINOR = 41;
/** Expected old value of `update-ref` for "the ref must not exist yet". */
export const NO_REF = '0'.repeat(40);
const PROJECT_ID = /^[a-f0-9]{24}$/;
export const OBJECT_ID = /^[0-9a-f]{7,64}$/;
export const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '-M'] as const;

export interface WorkspaceLimits {
  /** Largest file the viewer shows as text. */
  maxFileBytes: number;
  /** Largest file the raw route serves. */
  maxRawBytes: number;
  /** Total patch text of one diff. */
  maxPatchBytes: number;
  /** Patch text of one file within a diff. */
  maxFilePatchBytes: number;
  /** Output of the file list (`--raw`, `--numstat`) of one diff; the list is cut there. */
  maxListBytes: number;
  /** Files listed in one diff. */
  maxDiffFiles: number;
  /** Branches listed. */
  maxBranches: number;
  /** Commits listed when comparing a branch with main. */
  maxCompareCommits: number;
  /** Timeout of a single git call. */
  timeoutMs: number;
  /** Timeout and size cap of a ZIP download. */
  archiveTimeoutMs: number;
  archiveMaxBytes: number;
  /** Branches (main and `cvx/*`) the media listing scans. */
  maxMediaBranches: number;
  /** Distinct media files (blobs) the media listing collects. */
  maxMediaItems: number;
  /** Commits the media listing reads to find who wrote a file and when. */
  maxMediaLogCommits: number;
  /** Time budget of one media scan; branches past it are skipped and the scan is `truncated`. */
  mediaScanBudgetMs: number;
  /** How long a scan whose history walk failed is reused before the walk is tried again. */
  mediaHistoryRetryMs: number;
}

export const DEFAULT_LIMITS: WorkspaceLimits = {
  maxFileBytes: 1024 * 1024,
  maxRawBytes: MAX_RAW_BYTES,
  maxPatchBytes: 2 * 1024 * 1024,
  maxFilePatchBytes: 256 * 1024,
  maxListBytes: 4 * 1024 * 1024,
  maxDiffFiles: 1000,
  maxBranches: 200,
  maxCompareCommits: 250,
  timeoutMs: 15_000,
  archiveTimeoutMs: 5 * 60_000,
  archiveMaxBytes: 1024 * 1024 * 1024,
  maxMediaBranches: 200,
  maxMediaItems: 5000,
  maxMediaLogCommits: 5000,
  mediaScanBudgetMs: 20_000,
  mediaHistoryRetryMs: 60_000,
};

export interface ResolvedRef {
  ref: string;
  sha: string;
}

export interface Archive {
  sha: string;
  stream: Readable;
}

/** Reject paths outside the repository-relative form with a 400 before git sees them. */
export function assertRepoPath(path: string): void {
  if (!repoPathSchema.safeParse(path).success) {
    throw new AppError(400, 'invalid_path', 'The path must be relative to the repository root');
  }
}

export const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/** Directory mode below the workspace root: group-writable, setgid so entries keep the group. */
export const SHARED_DIR_MODE = 0o2770;

/**
 * Give a directory this process created the shared mode. A directory that belongs to another user
 * (the API and the runner share the tree through a group) keeps its mode.
 */
export async function shareDir(path: string): Promise<void> {
  try {
    await chmod(path, SHARED_DIR_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
  }
}

/** `mkdir -p` that gives every directory it creates the shared mode. */
export async function mkdirShared(path: string): Promise<void> {
  const first = await mkdir(path, { recursive: true });
  if (first === undefined) return;
  let current = path;
  const created = [];
  while (current.length >= first.length) {
    created.push(current);
    current = join(current, '..');
  }
  for (const dir of created) await shareDir(dir);
}

/**
 * Shared modes for a freshly cloned tree that only this process has seen: directories 2770,
 * files read-write for owner and group (executable for both when the owner may execute), nothing
 * for others. Symlinks are skipped.
 */
export async function shareTree(root: string): Promise<void> {
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop() ?? root;
    await chmod(dir, SHARED_DIR_MODE);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        const mode = (await lstat(path)).mode;
        await chmod(path, (mode & 0o100) !== 0 ? 0o770 : 0o660);
      }
    }
  }
}

/** Temporary directories younger than this may belong to another process still working. */
export const LEFTOVER_AGE_MS = 60 * 60_000;

/**
 * Remove temporary directories in `dir` whose names start with `prefix` and that are older than
 * LEFTOVER_AGE_MS, left behind by a process that died while creating a repository or clone. The
 * API and the runner both create clones, so a younger directory may still be in use.
 */
export async function removeLeftovers(
  dir: string,
  prefix: string,
  now = Date.now(),
): Promise<void> {
  for (const name of await readdir(dir)) {
    if (!name.startsWith(prefix)) continue;
    const path = join(dir, name);
    const info = await lstat(path).catch((error: unknown) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (info && now - info.mtimeMs > LEFTOVER_AGE_MS)
      await rm(path, { recursive: true, force: true });
  }
}

export class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

/** Project repositories: paths, creation, git calls and ref resolution. */
export class RepoBase {
  readonly root: string;
  protected readonly git: Git;
  protected readonly limits: WorkspaceLimits;
  protected readonly queue = new KeyedQueue();
  /** Domain of the no-reply addresses agents commit and merge with (`agent-<id>@<domain>`). */
  readonly agentEmailDomain: string;

  constructor(
    root: string,
    options: {
      gitBin?: string;
      limits?: Partial<WorkspaceLimits>;
      agentEmailDomain?: string;
    } = {},
  ) {
    this.root = resolve(root);
    this.git = new Git(options.gitBin ?? 'git');
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.agentEmailDomain = options.agentEmailDomain ?? DEFAULT_AGENT_EMAIL_DOMAIN;
  }

  /**
   * The git version, checked against the minimum this module needs (2.41 for
   * `%(ahead-behind)`); throws when git is missing or too old.
   */
  async checkGit(): Promise<string> {
    const output = await this.git.text(['--version'], { timeoutMs: this.limits.timeoutMs });
    const match = /(\d+)\.(\d+)/.exec(output);
    const [major, minor] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
    if (major < 2 || (major === 2 && minor < MIN_GIT_MINOR)) {
      throw new Error(`git 2.${MIN_GIT_MINOR} or newer is required, found: ${output}`);
    }
    return output;
  }

  /** The bare repository directory of a project. */
  repoDir(projectId: string): string {
    if (!PROJECT_ID.test(projectId)) throw new Error('invalid project id');
    return join(this.root, 'repos', `${projectId}.git`);
  }

  /** The directory of an issue's clone. */
  issueWorkspaceDir(projectId: string, issueKey: string): string {
    if (!PROJECT_ID.test(projectId)) throw new Error('invalid project id');
    if (!issueKeySchema.safeParse(issueKey).success) throw new Error('invalid issue key');
    return join(this.root, 'workspaces', projectId, issueKey);
  }

  protected repoArgs(projectId: string, args: readonly string[]): string[] {
    return [`--git-dir=${this.repoDir(projectId)}`, ...args];
  }

  protected run(projectId: string, args: readonly string[], maxBytes?: number) {
    return this.git.run(this.repoArgs(projectId, args), {
      timeoutMs: this.limits.timeoutMs,
      ...(maxBytes ? { maxBytes } : {}),
    });
  }

  protected async text(projectId: string, args: readonly string[]): Promise<string> {
    return (await this.run(projectId, args)).stdout.toString('utf8');
  }

  /**
   * Create the project's bare repository with an empty initial commit on main, unless it exists.
   * The repository is built in a temporary directory and renamed into place, so a half-created
   * repository is never visible and two concurrent calls cannot both create it.
   */
  async ensureRepo(projectId: string): Promise<void> {
    const dir = this.repoDir(projectId);
    if (await exists(dir)) return;
    await this.queue.run(`repo:${projectId}`, async () => {
      if (await exists(dir)) return;
      const repos = join(this.root, 'repos');
      await mkdirShared(repos);
      await removeLeftovers(repos, `.init-${projectId}-`);
      const temp = join(repos, `.init-${projectId}-${randomBytes(6).toString('hex')}`);
      try {
        const options = { timeoutMs: this.limits.timeoutMs };
        await this.git.run(
          [
            'init',
            '--bare',
            '--quiet',
            '--shared=0660',
            `--initial-branch=${DEFAULT_BRANCH}`,
            temp,
          ],
          options,
        );
        const gitDir = `--git-dir=${temp}`;
        await this.git.run([gitDir, 'config', 'core.logAllRefUpdates', 'true'], options);
        const tree = (await this.git.text([gitDir, 'mktree'], { ...options, input: '' })).trim();
        const commit = await this.git.text(
          [gitDir, 'commit-tree', tree, '-m', 'Initialize repository'],
          options,
        );
        await this.git.run(
          [gitDir, 'update-ref', `refs/heads/${DEFAULT_BRANCH}`, commit, NO_REF],
          options,
        );
        await rename(temp, dir);
      } catch (error) {
        await rm(temp, { recursive: true, force: true });
        if (await exists(join(dir, 'HEAD'))) return;
        throw error;
      }
    });
  }

  /** Reject branch names git would not accept as a branch; the name is returned unchanged. */
  async assertBranchName(name: string): Promise<string> {
    const valid =
      !name.startsWith('-') &&
      (await this.git.succeeds(['check-ref-format', '--branch', name], {
        timeoutMs: this.limits.timeoutMs,
      }));
    if (!valid) {
      throw new AppError(400, 'invalid_ref', `${name} is not a valid branch name`);
    }
    return name;
  }

  protected async commitOf(projectId: string, revision: string): Promise<string | null> {
    try {
      const { stdout } = await this.run(projectId, [
        'rev-parse',
        '--verify',
        '--quiet',
        `${revision}^{commit}`,
      ]);
      const sha = stdout.toString('utf8').trim();
      return OBJECT_ID.test(sha) ? sha : null;
    } catch (error) {
      if (error instanceof GitError && error.reason === 'exit') return null;
      throw error;
    }
  }

  /**
   * Resolve a branch name or commit id to a full commit id. A branch wins over a commit id with
   * the same spelling. Unknown refs are a 404; names git rejects are a 400.
   */
  async resolveRef(projectId: string, ref: string): Promise<ResolvedRef> {
    await this.ensureRepo(projectId);
    await this.assertBranchName(ref);
    const branchSha = await this.commitOf(projectId, `refs/heads/${ref}`);
    if (branchSha) return { ref, sha: branchSha };
    if (OBJECT_ID.test(ref)) {
      const sha = await this.commitOf(projectId, ref);
      if (sha) return { ref, sha };
    }
    throw notFound(`Ref ${ref}`);
  }

  /**
   * Resolve a branch name or a commit id (full or abbreviated, at least 7 hex digits) for a
   * writing operation. A branch resolves to its tip. A commit id must name a commit that is
   * reachable from at least one ref below `within` (ref prefixes such as `refs/heads/`), so
   * objects that no ref of the project points to (left over from a refused merge, for example)
   * are refused with 404 like unknown ones.
   */
  async resolveReachable(
    projectId: string,
    ref: string,
    within: readonly string[] = REACHABLE_FROM,
  ): Promise<ResolvedRef> {
    const resolved = await this.resolveRef(projectId, ref);
    if (resolved.ref === ref && (await this.commitOf(projectId, `refs/heads/${ref}`))) {
      return resolved;
    }
    const containing = await this.text(projectId, [
      'for-each-ref',
      '--count=1',
      '--format=%(refname)',
      `--contains=${resolved.sha}`,
      ...within,
    ]);
    if (containing.trim() === '') {
      throw notFound(`Commit ${ref} on a branch of this project`);
    }
    return resolved;
  }
}

/** Refs a commit id given to a writing operation must be reachable from by default. */
export const REACHABLE_FROM: readonly string[] = ['refs/heads/', 'refs/backup/'];
