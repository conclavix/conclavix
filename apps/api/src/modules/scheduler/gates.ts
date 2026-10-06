import type { ClientSession } from 'mongodb';
import { CLOSED_ISSUE_STATUSES, type WakeDeferReason, type WakeSkipReason } from '@conclavix/core';
import type { AgentDoc, Collections, IssueDoc, WakeDoc } from '../../db.js';
import { isActionable } from './wakes.js';
import { projectAccessChecker } from '../projects/agent-access.js';

export type GateResult =
  | { kind: 'run'; agent: AgentDoc; issue: IssueDoc }
  | { kind: 'skip'; reason: WakeSkipReason }
  | { kind: 'defer' }
  | { kind: 'defer_until'; reason: WakeDeferReason; until: Date };

const HOUR_MS = 60 * 60 * 1000;

const startOfUtcDay = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

const startOfNextUtcDay = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

/** Sum of the agent's run costs since UTC midnight. */
export async function costToday(
  collections: Collections,
  agent: AgentDoc,
  now: Date,
  session: ClientSession,
): Promise<number> {
  const [row] = await collections.runs
    .aggregate<{ total: number }>(
      [
        { $match: { agentId: agent._id, createdAt: { $gte: startOfUtcDay(now) } } },
        { $group: { _id: null, total: { $sum: '$costUsd' } } },
      ],
      { session },
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
 * Decide whether a wake becomes a run, is dropped with a reason, waits for a running run,
 * or waits until a rate or budget window frees (the hourly run window, or the next UTC day).
 */
export async function evaluateWake(
  collections: Collections,
  wake: WakeDoc,
  now: Date,
  session: ClientSession,
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
  const windowStart = new Date(now.getTime() - HOUR_MS);
  const recentRuns = await collections.runs
    .find(
      { agentId: agent._id, issueId: issue._id, createdAt: { $gte: windowStart } },
      { session, projection: { createdAt: 1 } },
    )
    .sort({ createdAt: 1 })
    .toArray();
  const oldest = recentRuns[0];
  if (oldest && recentRuns.length >= agent.limits.maxRunsPerIssuePerHour) {
    return {
      kind: 'defer_until',
      reason: 'run_rate_limit',
      until: new Date(oldest.createdAt.getTime() + HOUR_MS + 1),
    };
  }
  if ((await costToday(collections, agent, now, session)) >= agent.limits.maxCostPerDayUsd) {
    return { kind: 'defer_until', reason: 'daily_cost_limit', until: startOfNextUtcDay(now) };
  }
  return { kind: 'run', agent, issue };
}
