import type { ClientSession } from 'mongodb';
import type { Collections, IssueDoc } from '../../db.js';
import { unprocessable } from '../../errors.js';
import { agentExists, assertNoOpenChildren, isClosed } from './graph.js';

/**
 * Check that an issue may move to `status` and record the implied closedAt in `changes`.
 * Leaving in_review clears awaitingBoard: the board question belongs to in_review. The caller
 * withdraws the decision record afterwards (withdrawDecision) unless an answer settled it.
 * Callers hold the issue-graph and org-chart locks.
 */
export async function applyStatusChange(
  collections: Collections,
  current: IssueDoc,
  status: IssueDoc['status'],
  changes: Partial<IssueDoc>,
  session: ClientSession,
): Promise<void> {
  if (status !== 'in_review' && current.awaitingBoard) {
    changes.awaitingBoard = null;
  }
  const wasClosed = isClosed(current.status);
  const willBeClosed = isClosed(status);
  if (willBeClosed && !wasClosed) {
    await assertNoOpenChildren(collections, current._id, session);
    changes.closedAt = new Date();
  }
  if (!willBeClosed && wasClosed) {
    const parentId = changes.parentId === undefined ? current.parentId : changes.parentId;
    const parent = parentId
      ? await collections.issues.findOne({ _id: parentId }, { session })
      : null;
    if (parent && isClosed(parent.status)) {
      throw unprocessable('cannot reopen an issue whose parent is closed');
    }
    const assigneeId =
      changes.assigneeAgentId === undefined ? current.assigneeAgentId : changes.assigneeAgentId;
    const keepsAssignee = changes.assigneeAgentId === undefined;
    if (keepsAssignee && assigneeId && !(await agentExists(collections, assigneeId, session))) {
      throw unprocessable('cannot reopen: the assigned agent no longer exists; reassign it');
    }
    changes.closedAt = null;
  }
}
