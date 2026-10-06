import type { ClientSession, ObjectId } from 'mongodb';
import type { Collections, IssueDoc } from '../../db.js';
import { isActionable, requestWake } from '../scheduler/wakes.js';
import { reportTargets } from './links.js';
import { notify } from './notifications.js';

const MAX_SOURCE_DEPTH = 20;

/**
 * The issue a report target is woken on: the nearest issue above the closed one (following the
 * issue it was delegated from, else its parent) that is assigned to the target. Null when there is
 * none or when that issue is not actionable. Only issues strictly above the closed issue qualify, so
 * a report wake always moves up the tree and cannot wake anyone on the issue that just closed.
 */
async function reportTargetIssue(
  collections: Collections,
  closed: IssueDoc,
  targetId: ObjectId,
  session: ClientSession,
): Promise<IssueDoc | null> {
  const seen = new Set([closed._id.toHexString()]);
  let nextId = closed.delegatedFromIssueId ?? closed.parentId;
  for (let depth = 0; nextId && depth < MAX_SOURCE_DEPTH; depth += 1) {
    if (seen.has(nextId.toHexString())) {
      return null;
    }
    seen.add(nextId.toHexString());
    const current: IssueDoc | null = await collections.issues.findOne({ _id: nextId }, { session });
    if (!current) {
      return null;
    }
    if (current.assigneeAgentId?.equals(targetId)) {
      return isActionable(current) ? current : null;
    }
    nextId = current.delegatedFromIssueId ?? current.parentId;
  }
  return null;
}

/** Notify the assignee's report targets other than the delegator; wake those that asked for it. */
async function informReportTargets(
  collections: Collections,
  issue: IssueDoc,
  assigneeId: ObjectId,
  delegator: ObjectId,
  text: string,
  session: ClientSession,
): Promise<void> {
  const targets = await reportTargets(collections, assigneeId, session);
  for (const { agent, wakeOnReport } of targets) {
    if (agent._id.equals(delegator)) {
      continue;
    }
    await notify(
      collections,
      { agentId: agent._id, issueId: issue._id, kind: 'delegation_closed', text },
      session,
    );
    const home = wakeOnReport
      ? await reportTargetIssue(collections, issue, agent._id, session)
      : null;
    if (home) {
      await requestWake(collections, agent._id, home._id, 'report_closed', session);
    }
  }
}

/**
 * Report a delegated issue that just closed, inside the closing transaction.
 * The delegator is woken on the issue it delegated from (normally the parent) when that issue is
 * still its actionable work; otherwise it gets a notification so the result is not lost. Every
 * other `reports` target of the assignee gets a notification; a target whose link has
 * `wakeOnReport` is also woken on its own actionable issue above the closed one, if it has one.
 * Wakes pass the scheduler gates (paused agent, run rate, daily cost) like any other wake.
 */
export async function reportClosure(
  collections: Collections,
  issue: IssueDoc,
  session: ClientSession,
): Promise<void> {
  const delegator = issue.delegatedBy ?? null;
  if (!delegator) {
    return;
  }
  const assignee = issue.assigneeAgentId
    ? await collections.agents.findOne({ _id: issue.assigneeAgentId }, { session })
    : null;
  const text =
    `${issue.key} "${issue.title}" is ${issue.status}` +
    (assignee ? ` (worked on by ${assignee.name})` : '') +
    '.';
  const sourceId = issue.delegatedFromIssueId ?? issue.parentId;
  const source = sourceId ? await collections.issues.findOne({ _id: sourceId }, { session }) : null;
  if (source && source.assigneeAgentId?.equals(delegator) && isActionable(source)) {
    await requestWake(collections, delegator, source._id, 'delegation_closed', session);
  } else {
    await notify(
      collections,
      { agentId: delegator, issueId: issue._id, kind: 'delegation_closed', text },
      session,
    );
  }
  if (!assignee) {
    return;
  }
  await informReportTargets(collections, issue, assignee._id, delegator, text, session);
}
