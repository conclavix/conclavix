import type { IssueWorkspaceInfo } from '@conclavix/core';
import type { Database, IssueDoc } from '../../db.js';
import type { AuditActor, AuditLog } from '../audit/audit.js';

/**
 * Record an issue's workspace: the branch on the issue and one `issue.workspace_created` audit
 * entry per clone. The issue keeps the id of the clone it was audited for; the conditional update
 * on that id decides which caller writes the entry, so concurrent callers (API requests, runner)
 * and retries after a failed transaction write exactly one entry for each clone.
 */
export async function recordIssueWorkspace(
  database: Database,
  audit: AuditLog,
  issue: Pick<IssueDoc, '_id' | 'projectId' | 'key'>,
  info: IssueWorkspaceInfo,
  actor: AuditActor,
  ip: string | null = null,
): Promise<boolean> {
  return database.inTransaction(async (session) => {
    const recorded = await database.collections.issues.updateOne(
      { _id: issue._id, workspaceCloneId: { $ne: info.cloneId } },
      { $set: { branch: info.branch, workspaceCloneId: info.cloneId, updatedAt: new Date() } },
      { session },
    );
    if (recorded.modifiedCount !== 1) {
      await database.collections.issues.updateOne(
        { _id: issue._id, branch: { $ne: info.branch } },
        { $set: { branch: info.branch, updatedAt: new Date() } },
        { session },
      );
      return false;
    }
    await audit.write(
      {
        action: 'issue.workspace_created',
        actor,
        ip,
        details: {
          projectId: issue.projectId.toHexString(),
          issueKey: issue.key,
          branch: info.branch,
        },
      },
      session,
    );
    return true;
  });
}
