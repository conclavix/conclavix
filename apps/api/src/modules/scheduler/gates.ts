import type { ClientSession } from 'mongodb';
import { CLOSED_ISSUE_STATUSES, type WakeDeferReason, type WakeSkipReason } from '@conclavix/core';
import type { AgentDoc, Collections, IssueDoc, WakeDoc } from '../../db.js';
import { isActionable } from './wakes.js';
import { projectAccessChecker } from '../projects/agent-access.js';
import { idleRunLimit, idleStreak } from './loop-detection.js';

export type GateResult =
  | { kind: 'run'; agent: AgentDoc; issue: IssueDoc }
  | { kind: 'skip'; reason: WakeSkipReason }
  | { kind: 'defer' }
  | { kind: 'defer_until'; reason: WakeDeferReason; until: Date };

export interface GateOptions {
  /** How long a wake waits after the agent's idle-run limit was reached on the issue. */
  idleBackoffMs: number;
  /** Runs of one agent on one issue in 24 hours, with or without progress. */
  maxRunsPerIssuePerDay: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const startOfUtcDay = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

export const startOfNextUtcDay = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

/** Sum of the agent's run costs since UTC midnight, chat runs included. */
export async function costToday(
  collections: Collections,
  agent: AgentDoc,
  now: Date,
  session?: ClientSession,
): Promise<number> {
  const [row] = await collections.runs
    .aggregate<{ total: number }>(
      [
        { $match: { agentId: agent._id, createdAt: { $gte: startOfUtcDay(now) } } },
        { $group: { _id: null, total: { $sum: '$costUsd' } } },
      ],
      session ? { session } : {},
    )
    .toArray();
  return row?.total ?? 0;
}

async function issueGate(
  collections: Collections,
  wake: WakeDoc,
  session: ClientSession,
): Promise<GateResult | IssueDoc> {
  const issue = await collections.issues.findOne({ _id: wake.issueId }, { session });
  if (!issue) {
    return { kind: 'skip', reason: 'issue_missing' };
  }
  if ((CLOSED_ISSUE_STATUSES as readonly string[]).includes(issue.status)) {
    return { kind: 'skip', reason: 'issue_closed' };
  }
  if (!issue.assigneeAgentId?.equals(wake.agentId) || !isActionable(issue)) {
    return { kind: 'skip', reason: 'not_assigned' };
  }
  if (issue.checkoutRunId) {
    return { kind: 'defer' };
  }
  const openBlockers = await collections.issues.countDocuments(
    { _id: { $in: issue.blockedBy }, status: { $nin: [...CLOSED_ISSUE_STATUSES] } },
    { session },
  );
  return openBlockers > 0 ? { kind: 'skip', reason: 'blocked' } : issue;
}

/**
 * After `maxIdleRunsPerIssue` consecutive runs without progress the next run on the issue waits
 * `idleBackoffMs` after the last of them. A board wake (manual) skips the wait, so the board can
 * always get the agent going again; runs that make progress never count, so productive work is
 * never throttled by its number of runs.
 */
async function idleBackoff(
  collections: Collections,
  wake: WakeDoc,
  agent: AgentDoc,
  issue: IssueDoc,
  now: Date,
  options: GateOptions,
  session: ClientSession,
): Promise<GateResult | null> {
  if (wake.reason === 'manual' || wake.boardWake === true) {
    return null;
  }
  const limit = idleRunLimit(agent);
  const streak = await idleStreak(collections, agent._id, issue._id, limit, session);
  if (streak.count < limit || !streak.lastFinishedAt) {
    return null;
  }
  const until = new Date(streak.lastFinishedAt.getTime() + options.idleBackoffMs);
  return until > now ? { kind: 'defer_until', reason: 'idle_backoff', until } : null;
}

/**
 * Backstop for loops whose runs look like progress (a rewritten file, a status ping-pong): at most
 * `maxRunsPerIssuePerDay` runs of the agent on the issue in 24 hours. A hard brake like the cost
 * limits, so a board wake does not skip it; the wake waits until the oldest run leaves the window.
 */
async function issueRunCap(
  collections: Collections,
  agent: AgentDoc,
  issue: IssueDoc,
  now: Date,
  options: GateOptions,
  session: ClientSession,
): Promise<GateResult | null> {
  const recent = await collections.runs
    .find(
      {
        agentId: agent._id,
        issueId: issue._id,
        createdAt: { $gt: new Date(now.getTime() - DAY_MS) },
      },
      { session, projection: { createdAt: 1 } },
    )
    .sort({ createdAt: -1 })
    .limit(options.maxRunsPerIssuePerDay)
    .toArray();
  const oldest = recent.at(-1);
  if (!oldest || recent.length < options.maxRunsPerIssuePerDay) {
    return null;
  }
  return {
    kind: 'defer_until',
    reason: 'issue_run_cap',
    until: new Date(oldest.createdAt.getTime() + DAY_MS),
  };
}

/**
 * Decide whether a wake becomes a run, is dropped with a reason, waits for a running run,
 * or waits until a window frees (the idle backoff, the daily run cap per issue, or the next UTC day
 * for the cost limit).
 */
export async function evaluateWake(
  collections: Collections,
  wake: WakeDoc,
  now: Date,
  session: ClientSession,
  options: GateOptions,
): Promise<GateResult> {
  const agent = await collections.agents.findOne({ _id: wake.agentId }, { session });
  if (!agent) {
    return { kind: 'skip', reason: 'agent_missing' };
  }
  if (agent.status !== 'active') {
    return { kind: 'skip', reason: 'agent_paused' };
  }
  const issue = await issueGate(collections, wake, session);
  if ('kind' in issue) {
    return issue;
  }
  if (!(await projectAccessChecker(collections, issue.projectId, session)).isEnabled(agent)) {
    return { kind: 'skip', reason: 'agent_disabled_in_project' };
  }
  const backoff = await idleBackoff(collections, wake, agent, issue, now, options, session);
  if (backoff) {
    return backoff;
  }
  const capped = await issueRunCap(collections, agent, issue, now, options, session);
  if (capped) {
    return capped;
  }
  if ((await costToday(collections, agent, now, session)) >= agent.limits.maxCostPerDayUsd) {
    return { kind: 'defer_until', reason: 'daily_cost_limit', until: startOfNextUtcDay(now) };
  }
  return { kind: 'run', agent, issue };
}
