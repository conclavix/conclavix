import type { ClientSession, ObjectId } from 'mongodb';
import { CLOSED_ISSUE_STATUSES, type IssueStatus } from '@conclavix/core';
import type { Collections, IssueDoc } from '../../db.js';
import { unprocessable } from '../../errors.js';

const MAX_PARENT_DEPTH = 20;
const MAX_BLOCKER_SCAN = 5000;

/** True for statuses that end an issue's life (done or cancelled). */
export const isClosed = (status: IssueStatus): boolean =>
  (CLOSED_ISSUE_STATUSES as readonly IssueStatus[]).includes(status);

/** Reject a parent that is missing, in another project, closed, or would create a cycle. */
export async function assertValidParent(
  collections: Collections,
  issueId: ObjectId | null,
  parentId: ObjectId,
  projectId: ObjectId,
  session: ClientSession,
): Promise<void> {
  const parent = await collections.issues.findOne({ _id: parentId }, { session });
  if (!parent) {
    throw unprocessable('parentId refers to an issue that does not exist');
  }
  if (!parent.projectId.equals(projectId)) {
    throw unprocessable('parent issue belongs to another project');
  }
  if (isClosed(parent.status)) {
    throw unprocessable('parent issue is closed');
  }
  let current: Pick<IssueDoc, '_id' | 'parentId'> | null = parent;
  for (let depth = 0; current !== null; depth += 1) {
    if (issueId !== null && current._id.equals(issueId)) {
      throw unprocessable('parentId would create a cycle in the issue tree');
    }
    if (depth >= MAX_PARENT_DEPTH) {
      throw unprocessable(`issue tree is deeper than ${MAX_PARENT_DEPTH} levels`);
    }
    current = current.parentId
      ? await collections.issues.findOne(
          { _id: current.parentId },
          { projection: { parentId: 1 }, session },
        )
      : null;
  }
}

/** Reject blockers that are missing, the issue itself, or that transitively wait on the issue. */
export async function assertValidBlockers(
  collections: Collections,
  issueId: ObjectId | null,
  blockedBy: ObjectId[],
  session: ClientSession,
): Promise<void> {
  if (blockedBy.length === 0) {
    return;
  }
  if (issueId !== null && blockedBy.some((id) => id.equals(issueId))) {
    throw unprocessable('an issue cannot block itself');
  }
  const found = await collections.issues.countDocuments({ _id: { $in: blockedBy } }, { session });
  if (found !== blockedBy.length) {
    throw unprocessable('blockedBy refers to an issue that does not exist');
  }
  if (issueId === null) {
    return;
  }
  await assertNoBlockerCycle(collections, issueId, blockedBy, session);
}

async function assertNoBlockerCycle(
  collections: Collections,
  issueId: ObjectId,
  blockedBy: ObjectId[],
  session: ClientSession,
): Promise<void> {
  const seen = new Set<string>();
  let frontier = blockedBy;
  while (frontier.length > 0) {
    const next = await collections.issues
      .find({ _id: { $in: frontier } }, { projection: { blockedBy: 1 }, session })
      .toArray();
    frontier = [];
    for (const doc of next) {
      for (const id of doc.blockedBy) {
        if (id.equals(issueId)) {
          throw unprocessable('blockedBy would create a dependency cycle');
        }
        if (!seen.has(id.toHexString())) {
          seen.add(id.toHexString());
          frontier.push(id);
        }
      }
    }
    if (seen.size > MAX_BLOCKER_SCAN) {
      throw unprocessable('dependency graph is too large to validate');
    }
  }
}

/** Reject closing an issue while any of its children is still open. */
export async function assertNoOpenChildren(
  collections: Collections,
  issueId: ObjectId,
  session: ClientSession,
): Promise<void> {
  const open = await collections.issues.countDocuments(
    { parentId: issueId, status: { $nin: [...CLOSED_ISSUE_STATUSES] } },
    { session },
  );
  if (open > 0) {
    throw unprocessable('issue still has open children', { openChildren: open });
  }
}

/** True if the agent exists. */
export async function agentExists(
  collections: Collections,
  agentId: ObjectId,
  session: ClientSession,
): Promise<boolean> {
  const agent = await collections.agents.findOne(
    { _id: agentId },
    { projection: { _id: 1 }, session },
  );
  return agent !== null;
}

/** Reject an assignee that does not exist. */
export async function assertAgentExists(
  collections: Collections,
  agentId: ObjectId,
  session: ClientSession,
): Promise<void> {
  if (!(await agentExists(collections, agentId, session))) {
    throw unprocessable('assigneeAgentId refers to an agent that does not exist');
  }
}
