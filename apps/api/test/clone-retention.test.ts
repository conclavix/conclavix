import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ObjectId } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database, IssueDoc } from '../src/db.js';
import { assertRemovable, CloneRetention, treeBytes } from '../src/modules/workspace/retention.js';
import { Workspace } from '../src/modules/workspace/service.js';
import { commitAll, git, tempRoot } from './workspace-helpers.js';

const PROJECT = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 9, 9, 12);

type Status = IssueDoc['status'];

/** Just what the sweep reads: issues by project and key or id, and active runs by issue. */
function fakeDatabase(issues: IssueDoc[], activeRuns: ObjectId[] = []): Database {
  const matches = (issue: IssueDoc, filter: Record<string, unknown>) => {
    if (filter['_id']) return issue._id.equals(filter['_id'] as ObjectId);
    const keys = (filter['key'] as { $in: string[] }).$in;
    return issue.projectId.equals(filter['projectId'] as ObjectId) && keys.includes(issue.key);
  };
  return {
    collections: {
      issues: {
        find: (filter: Record<string, unknown>) => ({
          toArray: () => Promise.resolve(issues.filter((issue) => matches(issue, filter))),
        }),
        findOne: (filter: Record<string, unknown>) =>
          Promise.resolve(issues.find((issue) => matches(issue, filter)) ?? null),
      },
      runs: {
        countDocuments: (filter: { issueId: ObjectId }) =>
          Promise.resolve(activeRuns.filter((id) => id.equals(filter.issueId)).length),
      },
    },
  } as unknown as Database;
}

const issue = (key: string, status: Status, closedDaysAgo: number | null): IssueDoc =>
  ({
    _id: new ObjectId(),
    projectId: new ObjectId(PROJECT),
    key,
    status,
    closedAt: closedDaysAgo === null ? null : new Date(NOW - closedDaysAgo * DAY),
    updatedAt: new Date(NOW - 10 * DAY),
  }) as IssueDoc;

const silentLog = { info: () => undefined, warn: () => undefined, debug: () => undefined };

describe('CloneRetention', () => {
  let root: { dir: string; cleanup: () => void };
  let ws: Workspace;

  beforeEach(() => {
    root = tempRoot();
    ws = new Workspace(root.dir);
  });

  afterEach(() => {
    root.cleanup();
  });

  /** An issue clone whose branch is in sync with the project repository. */
  async function syncedClone(key: string): Promise<string> {
    await ws.createIssueWorkspace(PROJECT, key);
    const clone = ws.issueWorkspaceDir(PROJECT, key);
    mkdirSync(join(clone, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(clone, 'node_modules', 'pkg', 'index.js'), 'x'.repeat(10_000));
    return clone;
  }

  function staleClone(key: string, daysAgo: number): string {
    const dir = join(
      root.dir,
      'workspaces',
      PROJECT,
      `.stale-${key}-${NOW - daysAgo * DAY}-abcdef`,
    );
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'big.js'), 'y'.repeat(5000));
    return dir;
  }

  const retention = (database: Database, days = 3) =>
    new CloneRetention(database, ws, { days, log: silentLog, now: () => NOW });

  it('removes old closed and stale clones and keeps open, recent, running and unsynced ones', async () => {
    const done = issue('CVX-1', 'done', 5);
    const cancelled = issue('CVX-2', 'cancelled', 4);
    const open = issue('CVX-3', 'in_progress', null);
    const recent = issue('CVX-4', 'done', 1);
    const running = issue('CVX-5', 'done', 5);
    const unsynced = issue('CVX-6', 'done', 5);
    const legacy = { ...issue('CVX-8', 'done', null) };
    const clones = new Map<string, string>();
    for (const item of [done, cancelled, open, recent, running, unsynced, legacy]) {
      clones.set(item.key, await syncedClone(item.key));
    }
    const unsyncedClone = clones.get('CVX-6') ?? '';
    writeFileSync(join(unsyncedClone, 'work.txt'), 'w\n');
    commitAll(unsyncedClone, 'not synced');
    const oldStale = staleClone('CVX-3', 4);
    const newStale = staleClone('CVX-3', 1);

    const database = fakeDatabase(
      [done, cancelled, open, recent, running, unsynced, legacy],
      [running._id],
    );
    const result = await retention(database).sweep();

    expect(result?.removed.map((clone) => `${clone.kind}:${clone.name}`).sort()).toEqual([
      'closed:CVX-1',
      'closed:CVX-2',
      'closed:CVX-8',
      `stale:${oldStale.split('/').pop() ?? ''}`,
    ]);
    expect(result?.kept).toBe(2);
    expect(result?.errors).toBe(0);
    expect(result?.bytesFreed).toBeGreaterThan(3 * 10_000);
    for (const key of ['CVX-1', 'CVX-2', 'CVX-8'])
      expect(existsSync(clones.get(key) ?? '')).toBe(false);
    for (const key of ['CVX-3', 'CVX-4', 'CVX-5', 'CVX-6']) {
      expect(existsSync(clones.get(key) ?? '')).toBe(true);
    }
    expect(existsSync(oldStale)).toBe(false);
    expect(existsSync(newStale)).toBe(true);
    expect(git(ws.repoDir(PROJECT), 'branch', '--list', 'cvx/CVX-1')).toContain('cvx/CVX-1');

    const again = await ws.createIssueWorkspace(PROJECT, 'CVX-1');
    expect(again.created).toBe(true);
  });

  it('removes a clone half deleted by an interrupted sweep and leaves no move-aside behind', async () => {
    const done = issue('CVX-1', 'done', 5);
    await syncedClone('CVX-1');
    const leftover = join(root.dir, 'workspaces', PROJECT, `.removing-CVX-2-${NOW}-abcdef`);
    mkdirSync(join(leftover, 'node_modules'), { recursive: true });
    const result = await retention(fakeDatabase([done])).sweep();
    expect(result?.removed.map((clone) => clone.kind).sort()).toEqual(['closed', 'interrupted']);
    expect(existsSync(leftover)).toBe(false);
    expect(readdirSync(join(root.dir, 'workspaces', PROJECT))).toEqual([]);
  });

  it('keeps sweeping other projects when one project fails', async () => {
    const other = 'bbbbbbbbbbbbbbbbbbbbbbbb';
    const done = issue('CVX-1', 'done', 5);
    const clone = await syncedClone('CVX-1');
    await ws.ensureRepo(other);
    mkdirSync(join(root.dir, 'workspaces', other, 'OTH-1'), { recursive: true });
    const database = fakeDatabase([done]);
    const find = database.collections.issues.find.bind(database.collections.issues);
    (database.collections.issues as unknown as { find: unknown }).find = (
      filter: Record<string, unknown>,
    ) => {
      if ((filter['projectId'] as ObjectId).equals(new ObjectId(other))) {
        throw new Error('query failed');
      }
      return find(filter as never);
    };
    const result = await retention(database).sweep();
    expect(result?.errors).toBe(1);
    expect(result?.removed.map((item) => item.name)).toEqual(['CVX-1']);
    expect(existsSync(clone)).toBe(false);
  });

  it('reclaims a clone the agent user still owns and retries once', async () => {
    const done = issue('CVX-1', 'done', 5);
    const clone = await syncedClone('CVX-1');
    const calls: string[] = [];
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const remove = ws.removeIssueWorkspace.bind(ws);
    let first = true;
    ws.removeIssueWorkspace = (...args) => {
      if (first) {
        first = false;
        return Promise.reject(denied);
      }
      return remove(...args);
    };
    const sweeper = new CloneRetention(fakeDatabase([done]), ws, {
      days: 3,
      log: silentLog,
      now: () => NOW,
      reclaim: (projectId, key) => {
        calls.push(`${projectId}/${key}`);
        return Promise.resolve({ ok: true, detail: '' });
      },
    });
    const result = await sweeper.sweep();
    expect(calls).toEqual([`${PROJECT}/CVX-1`]);
    expect(result?.removed.map((item) => item.name)).toEqual(['CVX-1']);
    expect(existsSync(clone)).toBe(false);
  });

  it('counts an error when the clone cannot be reclaimed', async () => {
    const done = issue('CVX-1', 'done', 5);
    const clone = await syncedClone('CVX-1');
    const denied = Object.assign(new Error('permission denied'), { code: 'EPERM' });
    ws.removeIssueWorkspace = () => Promise.reject(denied);
    const sweeper = new CloneRetention(fakeDatabase([done]), ws, {
      days: 3,
      log: silentLog,
      now: () => NOW,
      reclaim: () => Promise.resolve({ ok: false, detail: 'exit 73' }),
    });
    const result = await sweeper.sweep();
    expect(result?.errors).toBe(1);
    expect(existsSync(clone)).toBe(true);
  });

  it('does nothing with 0 days', async () => {
    const done = issue('CVX-1', 'done', 400);
    const clone = await syncedClone('CVX-1');
    staleClone('CVX-1', 400);
    expect(await retention(fakeDatabase([done]), 0).sweep()).toBeNull();
    expect(existsSync(clone)).toBe(true);
  });

  it('leaves clones without a known issue alone', async () => {
    const clone = await syncedClone('CVX-9');
    const result = await retention(fakeDatabase([])).sweep();
    expect(result?.removed).toEqual([]);
    expect(existsSync(clone)).toBe(true);
  });

  it('refuses a stale clone that is a symlink to a directory elsewhere', async () => {
    const outside = join(root.dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'keep\n');
    await ws.ensureRepo(PROJECT);
    mkdirSync(join(root.dir, 'workspaces', PROJECT), { recursive: true });
    const link = join(root.dir, 'workspaces', PROJECT, `.stale-CVX-1-${NOW - 9 * DAY}-abcdef`);
    symlinkSync(outside, link);
    const result = await retention(fakeDatabase([])).sweep();
    expect(result?.removed).toEqual([]);
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    expect(existsSync(link)).toBe(true);
  });

  it('refuses a closed clone that is a symlink out of the workspace root', async () => {
    const done = issue('CVX-1', 'done', 9);
    const outside = join(root.dir, 'outside');
    mkdirSync(join(outside, '.git'), { recursive: true });
    await ws.ensureRepo(PROJECT);
    mkdirSync(join(root.dir, 'workspaces', PROJECT), { recursive: true });
    symlinkSync(outside, ws.issueWorkspaceDir(PROJECT, 'CVX-1'));
    const result = await retention(fakeDatabase([done])).sweep();
    expect(result?.removed).toEqual([]);
    expect(result?.errors).toBe(0);
    expect(existsSync(outside)).toBe(true);
  });
});

describe('assertRemovable', () => {
  let root: { dir: string; cleanup: () => void };
  beforeEach(() => {
    root = tempRoot();
  });
  afterEach(() => {
    root.cleanup();
  });

  it('accepts a real directory two levels below the base only', async () => {
    const base = join(root.dir, 'workspaces');
    mkdirSync(join(base, PROJECT, 'CVX-1', 'deeper'), { recursive: true });
    await expect(assertRemovable(base, join(base, PROJECT, 'CVX-1'))).resolves.toBeUndefined();
    await expect(assertRemovable(base, join(base, PROJECT))).rejects.toThrow(/outside/);
    await expect(assertRemovable(base, join(base, PROJECT, 'CVX-1', 'deeper'))).rejects.toThrow(
      /outside/,
    );
    await expect(assertRemovable(base, join(root.dir, 'elsewhere'))).rejects.toThrow();
  });

  it('refuses a path through a symlinked project directory', async () => {
    const base = join(root.dir, 'workspaces');
    mkdirSync(join(root.dir, 'real', 'CVX-1'), { recursive: true });
    mkdirSync(base);
    symlinkSync(join(root.dir, 'real'), join(base, PROJECT));
    await expect(assertRemovable(base, join(base, PROJECT, 'CVX-1'))).rejects.toThrow(/symlink/);
  });

  it('counts the bytes of a tree', async () => {
    mkdirSync(join(root.dir, 't', 'a'), { recursive: true });
    writeFileSync(join(root.dir, 't', 'a', 'f'), 'z'.repeat(20_000));
    expect(await treeBytes(join(root.dir, 't'))).toBeGreaterThanOrEqual(20_000);
  });
});
