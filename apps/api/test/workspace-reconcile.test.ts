import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ObjectId } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDoc, Database, IssueDoc, RunDoc } from '../src/db.js';
import type { AuditLog } from '../src/modules/audit/audit.js';
import { CodeWorkspace } from '../src/modules/workspace/commit.js';
import { CodeRuns } from '../src/runner/code-run.js';
import type { RunEventRecorder } from '../src/runner/events.js';
import { commitAll, git, tempRoot } from './workspace-helpers.js';

const PROJECT = 'eeeeeeeeeeeeeeeeeeeeeeee';
const ISSUE = 'APP-17';
const BRANCH = `cvx/${ISSUE}`;
const AGENT = { name: 'Conclavix Integrator', email: 'agent-9@conclavix.invalid' };

describe('CodeWorkspace.reconcileClone', () => {
  let root: { dir: string; cleanup: () => void };
  let ws: CodeWorkspace;
  let clone: string;
  let counter = 0;

  /** Push a commit with `files` on top of `from` to `target` in the bare repository. */
  function pushTo(from: string, target: string, files: Record<string, string>): string {
    counter += 1;
    const dir = join(root.dir, `helper-${counter}`);
    git(root.dir, 'clone', '--quiet', '--branch', from, ws.repoDir(PROJECT), dir);
    for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content);
    commitAll(dir, `change ${target}`);
    git(dir, 'push', '--quiet', 'origin', `HEAD:refs/heads/${target}`);
    return git(dir, 'rev-parse', 'HEAD');
  }

  const server = () => git(root.dir, `--git-dir=${ws.repoDir(PROJECT)}`, 'rev-parse', BRANCH);
  const head = () => git(clone, 'rev-parse', 'HEAD');
  const read = (path: string) => readFileSync(join(clone, path), 'utf8');

  /** Commit the work tree of the clone like the runner does after a run, and sync it. */
  async function runCommit(message: string) {
    const base = await ws.branchTip(PROJECT, ISSUE);
    await ws.commitIssueWork(PROJECT, ISSUE, { author: AGENT, message, base });
  }

  beforeEach(async () => {
    root = tempRoot('cvx-reconcile-');
    ws = new CodeWorkspace(join(root.dir, 'ws'));
    await ws.ensureRepo(PROJECT);
    pushTo('main', 'main', { 'shared.txt': 'one\n' });
    pushTo('main', 'cvx/APP-10', { 'ten.txt': 'ten\n' });
    pushTo('main', 'cvx/APP-11', { 'shared.txt': 'eleven\n' });
    await ws.createIssueWorkspace(PROJECT, ISSUE);
    clone = ws.issueWorkspaceDir(PROJECT, ISSUE);
  });

  afterEach(() => root.cleanup());

  const merge = (sources: string[]) =>
    ws.mergeIntoIssueBranch(PROJECT, ISSUE, { sources, author: AGENT });

  it('does nothing while the clone holds the server tip or is ahead of it', async () => {
    expect((await ws.reconcileClone(PROJECT, ISSUE, AGENT)).action).toBe('none');
    writeFileSync(join(clone, 'local.txt'), 'local\n');
    commitAll(clone, 'unsynced');
    const before = head();
    expect((await ws.reconcileClone(PROJECT, ISSUE, AGENT)).action).toBe('none');
    expect(head()).toBe(before);
    expect(git(clone, 'for-each-ref', 'refs/conclavix')).toBe('');
  });

  it('fast-forwards a clone the server branch moved ahead of', async () => {
    const merged = await merge(['cvx/APP-10']);
    const result = await ws.reconcileClone(PROJECT, ISSUE, AGENT);
    expect(result).toMatchObject({ action: 'fast_forward', head: merged.after });
    expect(head()).toBe(merged.after);
    expect(read('ten.txt')).toBe('ten\n');
    expect(git(clone, 'status', '--porcelain')).toBe('');
    expect(git(clone, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${BRANCH}`);
  });

  it('merges a clone with work of its own with the moved server branch', async () => {
    writeFileSync(join(clone, 'work.txt'), 'work\n');
    await runCommit('run work');
    const work = head();
    const merged = await merge(['cvx/APP-10']);
    const result = await ws.reconcileClone(PROJECT, ISSUE, AGENT);
    expect(result.action).toBe('merged');
    expect(server()).toBe(result.merge);
    expect(head()).toBe(result.merge);
    expect(git(clone, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').slice(1)).toEqual([
      work,
      merged.after,
    ]);
    expect(read('ten.txt')).toBe('ten\n');
    expect(read('work.txt')).toBe('work\n');
    expect(git(clone, 'status', '--porcelain')).toBe('');
    expect(
      git(root.dir, `--git-dir=${ws.repoDir(PROJECT)}`, 'for-each-ref', 'refs/conclavix'),
    ).toBe('');
    expect((await ws.syncIssueBranch(PROJECT, ISSUE, false)).updated).toBe(false);
  });

  it('keeps conflicting clone work on a conflict branch and resets the clone to the server', async () => {
    writeFileSync(join(clone, 'shared.txt'), 'mine\n');
    await runCommit('run work');
    const work = head();
    const merged = await merge(['cvx/APP-11']);
    const result = await ws.reconcileClone(PROJECT, ISSUE, AGENT);
    expect(result).toMatchObject({
      action: 'preserved',
      preservedBranch: `conflict/${ISSUE}/${work.slice(0, 12)}`,
      conflicts: [{ path: 'shared.txt', kinds: ['contents'] }],
      head: merged.after,
    });
    const bare = (...args: string[]) => git(root.dir, `--git-dir=${ws.repoDir(PROJECT)}`, ...args);
    expect(bare('rev-parse', `conflict/${ISSUE}/${work.slice(0, 12)}`)).toBe(work);
    expect(server()).toBe(merged.after);
    expect(head()).toBe(merged.after);
    expect(read('shared.txt')).toBe('eleven\n');
    expect(git(clone, 'status', '--porcelain')).toBe('');
  });

  it('commits uncommitted leftovers first, so they are merged or kept', async () => {
    const before = head();
    await merge(['cvx/APP-10']);
    writeFileSync(join(clone, 'left.txt'), 'left behind\n');
    const merged = await ws.reconcileClone(PROJECT, ISSUE, AGENT);
    expect(merged.action).toBe('merged');
    const leftover = git(clone, 'rev-parse', 'HEAD^1');
    expect(git(clone, 'rev-parse', `${leftover}^`)).toBe(before);
    expect(git(clone, 'log', '-1', '--format=%an|%s', leftover)).toBe(
      'Conclavix|Commit work an earlier run left uncommitted',
    );
    expect(read('left.txt')).toBe('left behind\n');
    expect(read('ten.txt')).toBe('ten\n');
    expect(git(clone, 'status', '--porcelain')).toBe('');

    const conflicting = await merge(['cvx/APP-11']);
    writeFileSync(join(clone, 'shared.txt'), 'uncommitted\n');
    const kept = await ws.reconcileClone(PROJECT, ISSUE, AGENT);
    expect(kept.action).toBe('preserved');
    const bare = (...args: string[]) => git(root.dir, `--git-dir=${ws.repoDir(PROJECT)}`, ...args);
    expect(bare('show', `${kept.preservedBranch ?? ''}:shared.txt`)).toBe('uncommitted');
    expect(head()).toBe(conflicting.after);
    expect(read('shared.txt')).toBe('eleven\n');
  });

  it('lets the runner integrate a merge made during the run', async () => {
    const database = {
      inTransaction: vi.fn(async () => false),
      collections: { runs: { updateOne: vi.fn().mockResolvedValue(undefined) } },
    } as unknown as Database;
    const runs = new CodeRuns(database, {} as AuditLog, ws);
    const events = { record: vi.fn() } as unknown as RunEventRecorder;
    const agent = { _id: new ObjectId(), name: 'Integrator' } as AgentDoc;
    const issue = {
      _id: new ObjectId(),
      projectId: new ObjectId(PROJECT),
      key: ISSUE,
      title: 'Integrate',
    } as IssueDoc;
    const run = { _id: new ObjectId() } as RunDoc;
    const sandbox = { result: 'success', exitCode: 0, diskBytes: 0 };

    const context = await runs.prepare(issue, null, events, agent);
    writeFileSync(join(clone, 'work.txt'), 'work\n');
    await merge(['cvx/APP-10']);
    const code = await runs.finish(
      context,
      agent,
      issue,
      run,
      { status: 'succeeded', costUsd: 0, summary: 'Add work', sandbox },
      events,
      (text) => text,
    );
    expect(code).toMatchObject({ synced: true, error: null });
    expect(server()).toBe(head());
    expect(read('ten.txt')).toBe('ten\n');
    expect(read('work.txt')).toBe('work\n');

    // The next run's clone starts from the server tip after another merge.
    pushTo('main', 'cvx/APP-12', { 'twelve.txt': 'twelve\n' });
    await ws.mergeIntoIssueBranch(PROJECT, ISSUE, { sources: ['cvx/APP-12'], author: AGENT });
    const next = await runs.prepare(issue, null, events, agent);
    expect(next.base).toBe(server());
    expect(head()).toBe(server());
    expect(existsSync(join(clone, 'twelve.txt'))).toBe(true);
  });
});
