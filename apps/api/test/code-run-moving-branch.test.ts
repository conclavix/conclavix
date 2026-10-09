import { ObjectId } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';
import type { AgentDoc, Database, IssueDoc, RunDoc } from '../src/db.js';
import { AppError } from '../src/errors.js';
import type { AuditLog } from '../src/modules/audit/audit.js';
import type { CodeWorkspace } from '../src/modules/workspace/commit.js';
import { CodeRuns } from '../src/runner/code-run.js';
import type { RunEventRecorder } from '../src/runner/events.js';

const agent = { _id: new ObjectId(), name: 'Coder' } as unknown as AgentDoc;
const issue = {
  _id: new ObjectId(),
  projectId: new ObjectId(),
  key: 'COD-9',
  title: 'Build the thing',
} as unknown as IssueDoc;
const run = { _id: new ObjectId() } as unknown as RunDoc;
const events = { record: vi.fn() } as unknown as RunEventRecorder;
const info = { issueKey: 'COD-9', branch: 'cvx/COD-9', head: '', created: false, cloneId: 'x' };

describe('CodeRuns.finish with a branch that keeps moving', () => {
  it('reconciles again and retries when the sync is refused because the branch moved', async () => {
    const events = { record: vi.fn() } as unknown as RunEventRecorder;
    const base = 'a'.repeat(40);
    const commitIssueWork = vi.fn().mockResolvedValue({
      branch: 'cvx/COD-9',
      head: 'b'.repeat(40),
      commit: 'b'.repeat(40),
      agentCommits: 0,
      stats: { files: 1, insertions: 1, deletions: 0 },
    });
    const syncIssueBranch = vi
      .fn()
      .mockRejectedValueOnce(new AppError(409, 'conflict', 'not a fast-forward'))
      .mockResolvedValue({ updated: true });
    const reconcileClone = vi
      .fn()
      .mockResolvedValue({ action: 'merged', head: 'c'.repeat(40), warnings: [] });
    const updateOne = vi.fn().mockResolvedValue(undefined);
    const runs = new CodeRuns(
      { collections: { runs: { updateOne } } } as unknown as Database,
      {} as AuditLog,
      {
        agentEmailDomain: 'conclavix.invalid',
        guardCloneHead: vi.fn().mockResolvedValue({ problems: [], setAside: null }),
        branchTip: vi.fn().mockResolvedValue(base),
        commitIssueWork,
        syncIssueBranch,
        reconcileClone,
      } as unknown as CodeWorkspace,
    );
    const code = await runs.finish(
      {
        projectId: issue.projectId.toHexString(),
        issueKey: 'COD-9',
        skillsDir: null,
        branch: 'cvx/COD-9',
        base,
        start: { tip: 'a'.repeat(40), logs: { head: 0, branch: 0 } },
      },
      agent,
      issue,
      run,
      {
        status: 'succeeded',
        costUsd: 0,
        sandbox: { result: 'success', exitCode: 0, diskBytes: 0 },
      },
      events,
      (text) => text,
    );
    expect(code).toMatchObject({ synced: true, error: null, head: 'c'.repeat(40) });
    expect(reconcileClone).toHaveBeenCalledTimes(1);
    expect(syncIssueBranch).toHaveBeenCalledTimes(2);
  });

  it('does not report a preserved run as synced', async () => {
    const base = 'a'.repeat(40);
    const runs = new CodeRuns(
      { collections: { runs: { updateOne: vi.fn() } } } as unknown as Database,
      {} as AuditLog,
      {
        agentEmailDomain: 'conclavix.invalid',
        guardCloneHead: vi.fn().mockResolvedValue({ problems: [], setAside: null }),
        branchTip: vi.fn().mockResolvedValue('d'.repeat(40)),
        commitIssueWork: vi.fn().mockResolvedValue({
          branch: 'cvx/COD-9',
          head: 'b'.repeat(40),
          commit: 'b'.repeat(40),
          agentCommits: 0,
          stats: { files: 1, insertions: 1, deletions: 0 },
        }),
        syncIssueBranch: vi.fn().mockResolvedValue({ updated: false }),
        reconcileClone: vi.fn().mockResolvedValue({
          action: 'preserved',
          head: 'd'.repeat(40),
          preservedBranch: 'conflict/COD-9/bbbbbbbbbbbb',
          conflicts: [{ path: 'a.txt', kinds: ['contents'] }],
          warnings: [],
        }),
      } as unknown as CodeWorkspace,
    );
    const code = await runs.finish(
      {
        projectId: issue.projectId.toHexString(),
        issueKey: 'COD-9',
        skillsDir: null,
        branch: 'cvx/COD-9',
        base,
        start: { tip: 'a'.repeat(40), logs: { head: 0, branch: 0 } },
      },
      agent,
      issue,
      run,
      {
        status: 'succeeded',
        costUsd: 0,
        sandbox: { result: 'success', exitCode: 0, diskBytes: 0 },
      },
      { record: vi.fn() } as unknown as RunEventRecorder,
      (text) => text,
    );
    expect(code.synced).toBe(false);
    expect(code.error).toContain('conflict/COD-9/bbbbbbbbbbbb');
    expect(code.commit).toBe('b'.repeat(40));
  });
});

describe('CodeRuns.prepare with a moving branch', () => {
  it('takes the base from the clone, not from a later read of the server branch', async () => {
    const database = { inTransaction: vi.fn(async () => false) } as unknown as Database;
    const workspace = {
      createIssueWorkspace: vi.fn().mockResolvedValue({ ...info, head: 'c'.repeat(40) }),
      branchTip: vi.fn().mockResolvedValue('f'.repeat(40)),
      cloneHeadState: vi
        .fn()
        .mockResolvedValue({ tip: 'a'.repeat(40), logs: { head: 0, branch: 0 } }),
      reconcileClone: vi
        .fn()
        .mockResolvedValue({ action: 'none', server: 'a'.repeat(40), warnings: [] }),
    };
    const runs = new CodeRuns(database, {} as AuditLog, workspace as unknown as CodeWorkspace);
    expect((await runs.prepare(issue, null, events)).base).toBe('a'.repeat(40));
    workspace.reconcileClone.mockResolvedValue({
      action: 'fast_forward',
      server: 'b'.repeat(40),
      head: 'b'.repeat(40),
      warnings: [],
    });
    expect((await runs.prepare(issue, null, events)).base).toBe('b'.repeat(40));
    workspace.createIssueWorkspace.mockResolvedValue({
      ...info,
      created: true,
      head: 'c'.repeat(40),
    });
    expect((await runs.prepare(issue, null, events)).base).toBe('c'.repeat(40));
    expect(workspace.branchTip).not.toHaveBeenCalled();
  });
});
