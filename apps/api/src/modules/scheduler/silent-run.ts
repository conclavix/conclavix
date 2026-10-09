import { ObjectId, type ClientSession } from 'mongodb';
import {
  isChatRun,
  type AgentDoc,
  type Collections,
  type Database,
  type IssueDoc,
  type RunDoc,
} from '../../db.js';
import { lockBoard, placeChangedIssue } from '../issues/columns.js';
import { assigneeCanRunNow, resumeWaitingIssue } from '../issues/resume.js';
import { notify } from '../org/notifications.js';
import { isActionable, requestWake } from './wakes.js';

/** Characters of the agent's last message quoted in the escalation comment. */
export const SILENT_RUN_TEXT_LIMIT = 600;

/** Who hears about a silent run: the agent that delegated the issue, or the board. */
type Target = { kind: 'agent'; agent: AgentDoc; source: IssueDoc | null } | { kind: 'board' };

export type SilentRunOutcome =
  | { escalated: false }
  | { escalated: true; target: 'board' | 'delegator'; delegatorWoken: boolean };

/** The agent's last message, redacted by the caller, cut to SILENT_RUN_TEXT_LIMIT characters. */
export function quoteFinalText(text: string | null | undefined): string {
  const trimmed = (text ?? '').trim();
  if (trimmed === '') return '(none)';
  const chars = [...trimmed];
  return chars.length <= SILENT_RUN_TEXT_LIMIT
    ? trimmed
    : `${chars.slice(0, SILENT_RUN_TEXT_LIMIT).join('')}…`;
}

/**
 * True when a finished run left something behind: progress (status change, document revision,
 * sub-issue, reopening, synced commit), a commit in the clone, a commit or sync error of the
 * runner (the work may sit uncommitted in the clone), or a comment of the agent on the issue while
 * it ran.
 */
export async function leftTrace(collections: Collections, run: RunDoc): Promise<boolean> {
  if (run.madeProgress !== false || !run.issueId) return true;
  // A commit, or work the runner could not commit (its error is on the run and in the log).
  const code = run.code;
  if (code && (code.commit !== null || code.agentCommits > 0 || code.error !== null)) return true;
  const comment = await collections.comments.findOne(
    {
      issueId: run.issueId,
      'author.type': 'agent',
      'author.agentId': run.agentId.toHexString(),
      createdAt: { $gte: run.startedAt ?? run.createdAt },
    },
    { projection: { _id: 1 } },
  );
  return comment !== null;
}

/**
 * True when this idle streak was escalated already: a mark for the same agent at the issue's
 * current progress count, and no run on the issue made progress since (synced commits do not
 * raise the counter).
 */
async function escalatedInStreak(
  collections: Collections,
  issue: IssueDoc,
  run: RunDoc,
  session: ClientSession,
): Promise<boolean> {
  const mark = issue.silentRun;
  if (!mark || !mark.agentId.equals(run.agentId) || issue.progress > mark.progress) return false;
  const progressed = await collections.runs.findOne(
    { issueId: issue._id, madeProgress: true, finishedAt: { $gt: mark.at } },
    { projection: { _id: 1 }, session },
  );
  return progressed === null;
}

/** The delegator (issue.delegatedBy) and the issue it delegated from, if it still holds that. */
async function resolveTarget(
  collections: Collections,
  issue: IssueDoc,
  run: RunDoc,
  session: ClientSession,
): Promise<Target> {
  const delegatorId = issue.delegatedBy ?? null;
  if (!delegatorId || delegatorId.equals(run.agentId)) return { kind: 'board' };
  const agent = await collections.agents.findOne({ _id: delegatorId }, { session });
  if (!agent) return { kind: 'board' };
  const sourceId = issue.delegatedFromIssueId ?? issue.parentId;
  const source = sourceId ? await collections.issues.findOne({ _id: sourceId }, { session }) : null;
  return {
    kind: 'agent',
    agent,
    source: source?.assigneeAgentId?.equals(agent._id) ? source : null,
  };
}

/** Wake the delegator on its source issue, handing an in_review one back first. */
async function wakeDelegator(
  collections: Collections,
  target: Extract<Target, { kind: 'agent' }>,
  session: ClientSession,
): Promise<boolean> {
  const { agent, source } = target;
  if (!source) return false;
  if (isActionable(source)) {
    // A paused or disabled delegator, or a blocked source, would have the wake skipped.
    if (!(await assigneeCanRunNow(collections, source, session))) return false;
    await requestWake(collections, agent._id, source._id, 'silent_run', session);
    return true;
  }
  return resumeWaitingIssue(collections, source, 'silent_run', session);
}

/** Move the issue to in_review so the board sees it among the issues waiting for it. */
async function handToBoard(
  collections: Collections,
  issue: IssueDoc,
  now: Date,
  session: ClientSession,
): Promise<void> {
  const { columns } = await lockBoard(collections, issue.projectId, session);
  const placement = placeChangedIssue(columns, issue, { status: 'in_review' });
  await collections.issues.updateOne(
    { _id: issue._id, status: issue.status },
    { $set: { ...placement, updatedAt: now } },
    { session },
  );
}

function commentBody(run: RunDoc, quote: string, action: string): string {
  return [
    `Run ${run._id.toHexString()} ended without a result: no comment, status change, document,`,
    'sub-issue or commit. Last message of the agent:',
    '',
    ...quote.split('\n').map((line) => `> ${line}`),
    '',
    action,
  ].join('\n');
}

/** What happens next, as the comment's last line; runs the wake or the move to in_review. */
async function act(
  collections: Collections,
  issue: IssueDoc,
  target: Target,
  now: Date,
  session: ClientSession,
): Promise<{ action: string; woken: boolean }> {
  if (target.kind === 'board') {
    await handToBoard(collections, issue, now, session);
    return {
      action:
        'Nobody delegated this issue, so it moved to in_review for the board. A board comment ' +
        'answers it: the issue goes back to in_progress and the agent is woken.',
      woken: false,
    };
  }
  const woken = await wakeDelegator(collections, target, session);
  const name = target.agent.name;
  await notify(
    collections,
    {
      agentId: target.agent._id,
      issueId: issue._id,
      kind: 'silent_run',
      text: `${issue.key} "${issue.title}": a run ended without a result; see the system comment there.`,
    },
    session,
  );
  if (woken && target.source) {
    return {
      action: `Escalated to ${name} (who delegated it), woken on ${target.source.key}.`,
      woken,
    };
  }
  // A delegator that cannot be woken now (its issue closed, reassigned, waiting for the board, or
  // the delegator paused) would only see the notification in some later run: the board takes it.
  await handToBoard(collections, issue, now, session);
  return {
    action:
      `${name} (who delegated it) was notified but cannot be woken on its issue now, so this ` +
      'issue moved to in_review for the board. A board comment answers it: the issue goes back ' +
      'to in_progress and the agent is woken.',
    woken,
  };
}

/**
 * Escalate an issue run that succeeded but left no trace while the issue still waits for work:
 * post the agent's last message as a system comment and wake the delegator on the issue it
 * delegated from, or hand the issue to the board (in_review) when nobody delegated it. Once per
 * idle streak (the issue's `silentRun` mark); failed, timed-out and cancelled runs, chat runs
 * and runs on an issue another run already took are left alone. `finalText` must be redacted.
 */
export async function escalateSilentRun(
  database: Database,
  run: RunDoc,
  finalText: string | null | undefined,
  now: Date,
): Promise<SilentRunOutcome> {
  const { collections } = database;
  const issueId = run.issueId;
  if (run.status !== 'succeeded' || isChatRun(run) || !issueId) return { escalated: false };
  if (await leftTrace(collections, run)) return { escalated: false };
  const quote = quoteFinalText(finalText);
  return database.inTransaction(async (session): Promise<SilentRunOutcome> => {
    const issue = await collections.issues.findOne({ _id: issueId }, { session });
    if (
      !issue ||
      !isActionable(issue) ||
      !issue.assigneeAgentId?.equals(run.agentId) ||
      issue.checkoutRunId !== null ||
      (await escalatedInStreak(collections, issue, run, session))
    ) {
      return { escalated: false };
    }
    const target = await resolveTarget(collections, issue, run, session);
    await collections.issues.updateOne(
      { _id: issue._id },
      {
        $set: {
          silentRun: { runId: run._id, agentId: run.agentId, progress: issue.progress, at: now },
        },
      },
      { session },
    );
    const { action, woken } = await act(collections, issue, target, now, session);
    await collections.comments.insertOne(
      {
        _id: new ObjectId(),
        issueId: issue._id,
        author: { type: 'system' },
        body: commentBody(run, quote, action),
        createdAt: now,
      },
      { session },
    );
    return {
      escalated: true,
      target: target.kind === 'board' ? 'board' : 'delegator',
      delegatorWoken: woken,
    };
  });
}
