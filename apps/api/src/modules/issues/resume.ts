import type { ClientSession, ObjectId } from 'mongodb';
import { CLOSED_ISSUE_STATUSES, type WakeReason } from '@conclavix/core';
import type { Collections, IssueDoc } from '../../db.js';
import { projectAccessChecker } from '../projects/agent-access.js';
import { requestWake } from '../scheduler/wakes.js';
import { lockBoard, placeChangedIssue } from './columns.js';

type Waiting = IssueDoc & { assigneeAgentId: NonNullable<IssueDoc['assigneeAgentId']> };

// An issue awaiting a board decision waits for the board's answer, not for other issues.
const waitingFilter = {
  status: 'in_review',
  assigneeAgentId: { $ne: null },
  awaitingBoard: null,
} as const;

/** True when the assignee could run now: it exists, is active and is enabled in the project. */
async function canRun(
  collections: Collections,
  issue: Waiting,
  session: ClientSession,
): Promise<boolean> {
  const agent = await collections.agents.findOne(
    { _id: issue.assigneeAgentId },
    { projection: { status: 1, projectDefault: 1 }, session },
  );
  if (!agent || agent.status !== 'active') {
    return false;
  }
  return (await projectAccessChecker(collections, issue.projectId, session)).isEnabled(agent);
}

/**
 * Move an in_review issue to in_progress (its board column follows) and wake its assignee.
 * An assignee that could not run keeps the issue in_review, so the board still sees it.
 */
async function resume(
  collections: Collections,
  issue: Waiting,
  reason: WakeReason,
  session: ClientSession,
): Promise<boolean> {
  const openBlockers = await collections.issues.countDocuments(
    { _id: { $in: issue.blockedBy }, status: { $nin: [...CLOSED_ISSUE_STATUSES] } },
    { session },
  );
  // A blocked issue's wake would be skipped; it stays in review until its last blocker closes.
  if (openBlockers > 0 || !(await canRun(collections, issue, session))) {
    return false;
  }
  const { columns } = await lockBoard(collections, issue.projectId, session);
  const placement = placeChangedIssue(columns, issue, { status: 'in_progress' });
  const moved = await collections.issues.updateOne(
    { _id: issue._id, status: 'in_review' },
    { $set: { ...placement, updatedAt: new Date() }, $inc: { progress: 1 } },
    { session },
  );
  if (moved.modifiedCount !== 1) {
    return false;
  }
  await requestWake(collections, issue.assigneeAgentId, issue._id, reason, session);
  return true;
}

/**
 * Hand back the assigned in_review issues that waited on `closed`, inside the transaction that
 * closes it: its parent (`subissue_closed`), and issues whose last open blocker it was
 * (`unblocked`). Each moves to in_progress and its assignee gets one wake; a pending wake for the
 * same agent and issue absorbs further ones, so several closures at once still queue one wake.
 * An issue awaiting a board decision (`awaitingBoard`) is left alone: the board's answer wakes it.
 * Returns the resumed issues: their wake is already queued, so the post-commit unblocked wakes
 * must leave them out, or a wake picked up in between would be followed by a second run.
 */
export async function resumeWaitingIssues(
  collections: Collections,
  closed: IssueDoc,
  session: ClientSession,
): Promise<ObjectId[]> {
  const resumed: ObjectId[] = [];
  if (closed.parentId) {
    const parent = (await collections.issues.findOne(
      { _id: closed.parentId, ...waitingFilter },
      { session },
    )) as Waiting | null;
    if (parent && (await resume(collections, parent, 'subissue_closed', session))) {
      resumed.push(parent._id);
    }
  }
  const blocked = (await collections.issues
    .find({ blockedBy: closed._id, ...waitingFilter }, { session })
    .toArray()) as Waiting[];
  for (const issue of blocked) {
    if (await resume(collections, issue, 'unblocked', session)) {
      resumed.push(issue._id);
    }
  }
  return resumed;
}
