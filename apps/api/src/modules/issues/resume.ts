import type { ClientSession } from 'mongodb';
import { CLOSED_ISSUE_STATUSES, type WakeReason } from '@conclavix/core';
import type { Collections, IssueDoc } from '../../db.js';
import { requestWake } from '../scheduler/wakes.js';
import { lockBoard, placeChangedIssue } from './columns.js';

type Waiting = IssueDoc & { assigneeAgentId: NonNullable<IssueDoc['assigneeAgentId']> };

const waitingFilter = { status: 'in_review', assigneeAgentId: { $ne: null } } as const;

/** Move an in_review issue to in_progress (its board column follows) and wake its assignee. */
async function resume(
  collections: Collections,
  issue: Waiting,
  reason: WakeReason,
  session: ClientSession,
): Promise<void> {
  const { columns } = await lockBoard(collections, issue.projectId, session);
  const placement = placeChangedIssue(columns, issue, { status: 'in_progress' });
  const moved = await collections.issues.updateOne(
    { _id: issue._id, status: 'in_review' },
    { $set: { ...placement, updatedAt: new Date() }, $inc: { progress: 1 } },
    { session },
  );
  if (moved.modifiedCount === 1) {
    await requestWake(collections, issue.assigneeAgentId, issue._id, reason, session);
  }
}

/**
 * Hand back the assigned in_review issues that waited on `closed`, inside the transaction that
 * closes it: its parent (`subissue_closed`), and issues whose last open blocker it was
 * (`unblocked`). Each moves to in_progress and its assignee gets one wake; a pending wake for the
 * same agent and issue absorbs further ones, so several closures at once still queue one wake.
 * The waiting agent may also have set in_review for a board decision; it is woken once per
 * closure and sets in_review again if it still needs the board.
 */
export async function resumeWaitingIssues(
  collections: Collections,
  closed: IssueDoc,
  session: ClientSession,
): Promise<void> {
  if (closed.parentId) {
    const parent = (await collections.issues.findOne(
      { _id: closed.parentId, ...waitingFilter },
      { session },
    )) as Waiting | null;
    if (parent) {
      await resume(collections, parent, 'subissue_closed', session);
    }
  }
  const blocked = (await collections.issues
    .find({ blockedBy: closed._id, ...waitingFilter }, { session })
    .toArray()) as Waiting[];
  for (const issue of blocked) {
    const open = await collections.issues.countDocuments(
      { _id: { $in: issue.blockedBy }, status: { $nin: [...CLOSED_ISSUE_STATUSES] } },
      { session },
    );
    if (open === 0) {
      await resume(collections, issue, 'unblocked', session);
    }
  }
}
