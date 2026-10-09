import { randomBytes } from 'node:crypto';
import { lstat, readdir, realpath, rename, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { issueKeySchema } from '@conclavix/core';
import { ObjectId } from 'mongodb';
import type { Logger } from 'pino';
import type { Database, IssueDoc } from '../../db.js';
import { AppError } from '../../errors.js';
import { isMissing } from './repo-base.js';
import type { Workspace } from './service.js';

const DAY_MS = 24 * 60 * 60_000;
const PROJECT_DIR = /^[a-f0-9]{24}$/;
/** Name CodeWorkspace.setAside gives a clone it moved out of the way. */
const STALE_DIR = /^\.stale-([A-Z][A-Z0-9]{1,5}-[1-9][0-9]*)-([0-9]{13})-[0-9a-f]{6}$/;
/**
 * A clone the sweep moved out of the way before deleting it, so a removal interrupted by a
 * restart never leaves a half-deleted clone at the issue's path; removed by the next sweep.
 */
const REMOVING_DIR = /^\.removing-([A-Z][A-Z0-9]{1,5}-[1-9][0-9]*)-([0-9]{13})-[0-9a-f]{6}$/;
const CLOSED = new Set<IssueDoc['status']>(['done', 'cancelled']);
const ACTIVE_RUNS = ['queued', 'running'] as const;

export interface RemovedClone {
  projectId: string;
  name: string;
  kind: 'closed' | 'stale' | 'interrupted';
  bytes: number;
}

export interface SweepResult {
  at: Date;
  removed: RemovedClone[];
  bytesFreed: number;
  /** Clones that qualified by age but stayed: unsynced work, a run, a refused path. */
  kept: number;
  errors: number;
}

export interface RetentionOptions {
  /** CODE_CLONE_RETENTION_DAYS; 0 turns the sweep off. */
  days: number;
  log: Pick<Logger, 'info' | 'warn' | 'debug'>;
  now?: () => number;
  /** Hands a clone left with the agent user back to the runner (the helper's `release`). */
  reclaim?: (projectId: string, issueKey: string) => Promise<{ ok: boolean; detail: string }>;
}

/** Bytes a directory tree occupies on disk (allocated blocks), without following symlinks. */
export async function treeBytes(root: string): Promise<number> {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop() ?? root;
    total += (await lstat(dir)).blocks * 512;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else total += (await lstat(path)).blocks * 512;
    }
  }
  return total;
}

/**
 * Refuse to remove `path` unless it is a real directory (not a symlink) directly below a project
 * directory of `base`, with no symlink anywhere on the way: its real path must be itself.
 */
export async function assertRemovable(base: string, path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${path} is not a real directory`);
  }
  const real = await realpath(path);
  const relative = real.startsWith(`${base}${sep}`) ? real.slice(base.length + 1) : null;
  if (real !== path || relative === null || relative.split(sep).length !== 2) {
    throw new Error(`${path} lies outside the workspace root or behind a symlink`);
  }
}

/**
 * Removes issue clones that are no longer needed (docs/workspace.md#clone-retention): the clone
 * of an issue that has been done or cancelled for longer than the retention, and `.stale-*`
 * clones set aside longer ago than that. The branch stays in the project repository; a reopened
 * issue gets a fresh clone from it. A clone is kept while its issue is open again, while a run of
 * the issue is queued or running, while it holds commits the project repository lacks, and when
 * its path is not a real directory below the workspace root.
 */
export class CloneRetention {
  private last: SweepResult | null = null;

  constructor(
    private readonly database: Database,
    private readonly workspace: Workspace,
    private readonly options: RetentionOptions,
  ) {}

  /** The result of the last completed sweep. */
  get lastResult(): SweepResult | null {
    return this.last;
  }

  private get now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** One pass over all project clone directories; null when retention is off. */
  async sweep(): Promise<SweepResult | null> {
    if (this.options.days <= 0) return null;
    const result: SweepResult = {
      at: new Date(this.now),
      removed: [],
      bytesFreed: 0,
      kept: 0,
      errors: 0,
    };
    let base: string;
    try {
      base = await realpath(join(this.workspace.root, 'workspaces'));
    } catch (error) {
      if (isMissing(error)) return this.finish(result);
      throw error;
    }
    for (const entry of await readdir(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || !PROJECT_DIR.test(entry.name)) continue;
      try {
        await this.sweepProject(base, entry.name, result);
      } catch (error) {
        // One unreadable project directory or failed query must not stop the others.
        this.failed(result, entry.name, '*', error);
      }
    }
    return this.finish(result);
  }

  private finish(result: SweepResult): SweepResult {
    this.last = result;
    this.options.log.info(
      {
        removed: result.removed.length,
        bytesFreed: result.bytesFreed,
        kept: result.kept,
        errors: result.errors,
      },
      'clone retention sweep finished',
    );
    return result;
  }

  private async sweepProject(base: string, projectId: string, result: SweepResult): Promise<void> {
    const cutoff = this.now - this.options.days * DAY_MS;
    const keys: string[] = [];
    for (const entry of await readdir(join(base, projectId), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const stale = STALE_DIR.exec(entry.name);
      if (stale) {
        if (Number(stale[2]) < cutoff) {
          await this.removeAside(base, projectId, entry.name, 'stale', result);
        }
      } else if (REMOVING_DIR.test(entry.name)) {
        await this.removeAside(base, projectId, entry.name, 'interrupted', result);
      } else if (issueKeySchema.safeParse(entry.name).success) {
        keys.push(entry.name);
      }
    }
    if (keys.length === 0) return;
    const issues = await this.database.collections.issues
      .find({ projectId: new ObjectId(projectId), key: { $in: keys } })
      .toArray();
    for (const issue of issues) {
      if (!CLOSED.has(issue.status) || closedAt(issue) >= cutoff) continue;
      await this.removeClosed(base, projectId, issue, cutoff, result);
    }
  }

  /** Remove a directory next to the clones that nothing uses: set aside or half removed. */
  private async removeAside(
    base: string,
    projectId: string,
    name: string,
    kind: 'stale' | 'interrupted',
    result: SweepResult,
  ): Promise<void> {
    const path = join(base, projectId, name);
    try {
      await assertRemovable(base, path);
      const bytes = await treeBytes(path);
      await rm(path, { recursive: true, force: true });
      this.removed(result, { projectId, name, kind, bytes });
    } catch (error) {
      this.failed(result, projectId, name, error);
    }
  }

  private async removeClosed(
    base: string,
    projectId: string,
    issue: IssueDoc,
    cutoff: number,
    result: SweepResult,
  ): Promise<void> {
    try {
      await this.removeClosedOnce(base, projectId, issue, cutoff, result);
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 409) {
        result.kept += 1;
        this.options.log.warn(
          { projectId, clone: issue.key },
          'clone of a closed issue kept: it holds work the project repository lacks',
        );
        return;
      }
      const code = (error as NodeJS.ErrnoException).code;
      const reclaim = this.options.reclaim;
      if ((code !== 'EACCES' && code !== 'EPERM') || !reclaim) {
        this.failed(result, projectId, issue.key, error);
        return;
      }
      // Still owned by the agent user after a helper that died mid-run: hand it back, retry once.
      const reclaimed = await reclaim(projectId, issue.key);
      if (!reclaimed.ok) {
        this.failed(result, projectId, issue.key, new Error(`reclaim failed: ${reclaimed.detail}`));
        return;
      }
      await this.removeClosedOnce(base, projectId, issue, cutoff, result).catch((retry: unknown) =>
        this.failed(result, projectId, issue.key, retry),
      );
    }
  }

  /**
   * Remove one closed issue's clone. The issue and its runs are checked again under the clone's
   * lock, right before the removal; the clone is renamed away atomically there
   * (removeIssueWorkspace's own rm then finds nothing) and deleted afterwards.
   */
  private async removeClosedOnce(
    base: string,
    projectId: string,
    issue: IssueDoc,
    cutoff: number,
    result: SweepResult,
  ): Promise<void> {
    if (!(await this.stillRemovable(issue._id, cutoff))) {
      result.kept += 1;
      return;
    }
    const path = join(base, projectId, issue.key);
    let bytes = 0;
    let moved: string | null = null;
    const canRemove = async (): Promise<boolean> => {
      if (!(await this.stillRemovable(issue._id, cutoff))) return false;
      await assertRemovable(base, path);
      bytes = await treeBytes(path);
      const suffix = `${this.now}-${randomBytes(3).toString('hex')}`;
      moved = join(base, projectId, `.removing-${issue.key}-${suffix}`);
      await rename(path, moved);
      return true;
    };
    if (!(await this.workspace.removeIssueWorkspace(projectId, issue.key, false, canRemove))) {
      result.kept += 1;
      return;
    }
    if (moved) await rm(moved, { recursive: true, force: true });
    this.removed(result, { projectId, name: issue.key, kind: 'closed', bytes });
  }

  /** The issue is still closed since before the cutoff and no run of it is queued or running. */
  private async stillRemovable(issueId: ObjectId, cutoff: number): Promise<boolean> {
    const issue = await this.database.collections.issues.findOne({ _id: issueId });
    if (!issue || !CLOSED.has(issue.status) || closedAt(issue) >= cutoff) return false;
    const active = await this.database.collections.runs.countDocuments(
      { issueId, status: { $in: [...ACTIVE_RUNS] } },
      { limit: 1 },
    );
    return active === 0;
  }

  private removed(result: SweepResult, clone: RemovedClone): void {
    result.removed.push(clone);
    result.bytesFreed += clone.bytes;
    this.options.log.info(
      { projectId: clone.projectId, clone: clone.name, kind: clone.kind, bytes: clone.bytes },
      'removed issue clone',
    );
  }

  private failed(result: SweepResult, projectId: string, name: string, error: unknown): void {
    result.errors += 1;
    this.options.log.warn(
      { projectId, clone: name, err: error instanceof Error ? error.message : String(error) },
      'clone retention could not remove a clone',
    );
  }
}

/** When the issue was closed; issues closed before closedAt existed fall back to updatedAt. */
const closedAt = (issue: IssueDoc): number => (issue.closedAt ?? issue.updatedAt).getTime();

/** First sweep a few minutes after startup, then hourly; returns a stop function. */
export function scheduleCloneRetention(
  retention: CloneRetention,
  log: Pick<Logger, 'warn'>,
  { firstMs = 5 * 60_000, everyMs = 60 * 60_000 } = {},
): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    retention
      .sweep()
      .catch((error: unknown) => log.warn({ err: error }, 'clone retention sweep failed'))
      .finally(() => {
        running = false;
      });
  };
  const first = setTimeout(tick, firstMs);
  const every = setInterval(tick, everyMs);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
