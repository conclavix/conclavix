import { ObjectId, type ClientSession } from 'mongodb';
import { CLOSED_ISSUE_STATUSES, type IssueStatus, type WakeReason } from '@conclavix/core';
import type { Collections, IssueDoc } from '../../db.js';
import { isDuplicateKeyError } from '../../errors.js';

/** Statuses in which an assigned agent is expected to work on an issue. */
export const ACTIONABLE_STATUSES: readonly IssueStatus[] = ['todo', 'in_progress'];

export const isActionable = (issue: Pick<IssueDoc, 'status' | 'assigneeAgentId'>): boolean =>
  issue.assigneeAgentId !== null && ACTIONABLE_STATUSES.includes(issue.status);

/**
 * Queue a wake for (agent, issue); a pending wake for the same pair absorbs the new one.
 * A manual (board) wake also lets an absorbing deferred wake be re-checked on the next tick and
 * marks it as a board wake, so raising an agent's limits takes effect without waiting for the old
 * window and an idle backoff never holds back the board.
 */
export async function requestWake(
  collections: Collections,
  agentId: ObjectId,
  issueId: ObjectId,
  reason: WakeReason,
  session?: ClientSession,
): Promise<boolean> {
  try {
    const result = await collections.wakes.updateOne(
      { agentId, issueId, processedAt: null },
      {
        $setOnInsert: {
          _id: new ObjectId(),
          agentId,
          issueId,
          reason,
          createdAt: new Date(),
          processedAt: null,
          runId: null,
          skipReason: null,
        },
        ...(reason === 'manual' ? { $set: { notBefore: null, boardWake: true } } : {}),
      },
      { upsert: true, ...(session ? { session } : {}) },
    );
    return result.upsertedCount === 1;
  } catch (error) {
    if (!session && isDuplicateKeyError(error)) {
      return false;
    }
    throw error;
  }
}

/** Wake the assignees of issues that were waiting only on the issue that just closed. */
export async function wakeUnblocked(
  collections: Collections,
  closedIssueId: ObjectId,
  exclude: readonly ObjectId[] = [],
): Promise<void> {
  const waiting = await collections.issues
    .find({
      blockedBy: closedIssueId,
      status: { $in: [...ACTIONABLE_STATUSES] },
      ...(exclude.length > 0 ? { _id: { $nin: [...exclude] } } : {}),
    })
    .toArray();
  for (const issue of waiting) {
    if (!issue.assigneeAgentId) {
      continue;
    }
    const open = await collections.issues.countDocuments({
      _id: { $in: issue.blockedBy },
      status: { $nin: [...CLOSED_ISSUE_STATUSES] },
    });
    if (open === 0) {
      await requestWake(collections, issue.assigneeAgentId, issue._id, 'unblocked');
    }
  }
}

const isClosedStatus = (status: IssueStatus): boolean =>
  (CLOSED_ISSUE_STATUSES as readonly IssueStatus[]).includes(status);

/**
 * Create the wakes implied by an issue change; runs after the change is committed. `resumed` are
 * issues the closing transaction already handed back with their own wake (resumeWaitingIssues).
 */
export async function wakeOnIssueChange(
  collections: Collections,
  before: IssueDoc | null,
  after: IssueDoc,
  resumed: readonly ObjectId[] = [],
): Promise<void> {
  const becameActionable = isActionable(after) && (before === null || !isActionable(before));
  const reassigned =
    before !== null &&
    after.assigneeAgentId !== null &&
    !after.assigneeAgentId.equals(
      before.assigneeAgentId ?? new ObjectId('000000000000000000000000'),
    );
  if (after.assigneeAgentId && isActionable(after) && (becameActionable || reassigned)) {
    try {
      await requestWake(collections, after.assigneeAgentId, after._id, 'assigned');
    } catch (error) {
      logDeferredWake(after._id, error);
    }
  }
  if (isClosedStatus(after.status) && !(before !== null && isClosedStatus(before.status))) {
    await wakeUnblockedOrLog(collections, after._id, resumed);
  }
}

async function wakeUnblockedOrLog(
  collections: Collections,
  closedIssueId: ObjectId,
  resumed: readonly ObjectId[],
): Promise<void> {
  try {
    await wakeUnblocked(collections, closedIssueId, resumed);
  } catch (error) {
    logDeferredWake(closedIssueId, error);
  }
}

function logDeferredWake(issueId: ObjectId, cause: unknown): void {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.emitWarning(
    new Error(
      `Wake deferred for issue ${issueId.toHexString()}; heartbeat sweep can retry: ${message}`,
      { cause },
    ),
  );
}
