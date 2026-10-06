import type { Issue } from '@conclavix/core';
import type { IssueDoc } from '../../db.js';

/** Convert a stored issue into its API shape. */
export const toIssue = (doc: IssueDoc): Issue => ({
  id: doc._id.toHexString(),
  key: doc.key,
  projectId: doc.projectId.toHexString(),
  number: doc.number,
  title: doc.title,
  description: doc.description,
  status: doc.status,
  columnId: doc.columnId ?? null,
  priority: doc.priority,
  parentId: doc.parentId ? doc.parentId.toHexString() : null,
  assigneeAgentId: doc.assigneeAgentId ? doc.assigneeAgentId.toHexString() : null,
  blockedBy: doc.blockedBy.map((id) => id.toHexString()),
  labels: doc.labels,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
  closedAt: doc.closedAt,
  checkoutRunId: doc.checkoutRunId ? doc.checkoutRunId.toHexString() : null,
  delegatedBy: doc.delegatedBy ? doc.delegatedBy.toHexString() : null,
  branch: doc.branch ?? null,
});
