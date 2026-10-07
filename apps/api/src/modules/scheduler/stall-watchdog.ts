import { CLOSED_ISSUE_STATUSES } from '@conclavix/core';
import type { ObjectId } from 'mongodb';
import type { Collections, IssueDoc } from '../../db.js';
import { disabledAssignments } from '../projects/agent-access.js';
import { idleRunLimit, idleStreak } from './loop-detection.js';
import { ACTIONABLE_STATUSES, requestWake } from './wakes.js';

/** What one watchdog sweep found; logged once per sweep. */
export interface StallSweep {
  /** Idle issues of active, enabled agents that were checked. */
  candidates: number;
  /** Stall wakes queued. */
  woken: number;
  /** Left alone: waiting for an open sub-issue, which wakes the issue when it closes. */
  openSubIssues: number;
  /** Left alone: an open blocker, whose closing wakes the issue ('unblocked'). */
  openBlockers: number;
  /** Left alone: a wake for the issue is already pending (also a deferred one). */
  pendingWake: number;
  /** Left alone: a run on the issue is queued or running, or finished within the interval. */
  recentRun: number;
  /** Left alone: the agent reached its idle-run limit on the issue; the heartbeat takes over. */
  idle: number;
}

const ids = (values: readonly { _id: ObjectId }[] | readonly ObjectId[]): Set<string> =>
  new Set(values.map((value) => ('_id' in value ? value._id : value).toHexString()));

/** Idle todo/in_progress issues of active agents enabled in their project, and those agents. */
async function findCandidates(collections: Collections, cutoff: Date, limit: number) {
  const [disabled, agents] = await Promise.all([
    disabledAssignments(collections),
    collections.agents.find({ status: 'active' }, { projection: { limits: 1 } }).toArray(),
  ]);
  if (agents.length === 0) return { agents, issues: [] as IssueDoc[] };
  const issues: IssueDoc[] = await collections.issues
    .find({
      status: { $in: [...ACTIONABLE_STATUSES] },
      assigneeAgentId: { $in: agents.map((agent) => agent._id) },
      checkoutRunId: null,
      updatedAt: { $lt: cutoff },
      $or: [{ lastRunAt: null }, { lastRunAt: { $lt: cutoff } }],
      ...(disabled.length > 0 ? { $nor: disabled } : {}),
    })
    .limit(limit)
    .toArray();
  return { agents, issues };
}

/**
 * Find issues an agent could work on but where nothing happens, and queue one `stall_watchdog`
 * wake for each. Candidates are `todo`/`in_progress` issues (never `in_review`: those wait for the
 * board, and the ones waiting for sub-issues or blockers are handed back when those close) of an
 * active agent enabled in the project, not checked out, with no change and no run start within
 * the interval. Left alone are issues with an open sub-issue or blocker, a pending wake, a queued,
 * running or recently finished run, and issues on which the agent already reached its idle-run
 * limit, so the watchdog never pushes an agent into the idle backoff or the loop pause. The wakes
 * pass the scheduler gates like heartbeat wakes.
 */
export async function sweepStalls(
  collections: Collections,
  intervalMinutes: number,
  limit: number,
  now: Date,
): Promise<StallSweep> {
  const sweep: StallSweep = {
    candidates: 0,
    woken: 0,
    openSubIssues: 0,
    openBlockers: 0,
    pendingWake: 0,
    recentRun: 0,
    idle: 0,
  };
  if (intervalMinutes <= 0) return sweep;
  const cutoff = new Date(now.getTime() - intervalMinutes * 60_000);
  const { agents, issues } = await findCandidates(collections, cutoff, limit);
  sweep.candidates = issues.length;
  if (issues.length === 0) return sweep;
  const issueIds = issues.map((issue) => issue._id);
  const open = { $nin: [...CLOSED_ISSUE_STATUSES] };
  const [parents, blockers, pending, runs] = await Promise.all([
    collections.issues.distinct('parentId', { parentId: { $in: issueIds }, status: open }),
    collections.issues
      .find(
        { _id: { $in: issues.flatMap((issue) => issue.blockedBy) }, status: open },
        { projection: { _id: 1 } },
      )
      .toArray(),
    collections.wakes.distinct('issueId', { issueId: { $in: issueIds }, processedAt: null }),
    collections.runs.distinct('issueId', {
      issueId: { $in: issueIds },
      $or: [{ status: { $in: ['queued', 'running'] } }, { finishedAt: { $gte: cutoff } }],
    }),
  ]);
  const withChildren = ids(parents.filter((id): id is ObjectId => id !== null));
  const openBlockers = ids(blockers);
  const withWake = ids(pending);
  const withRun = ids(runs);
  const limits = new Map(agents.map((agent) => [agent._id.toHexString(), idleRunLimit(agent)]));
  for (const issue of issues) {
    const key = issue._id.toHexString();
    const agentId = issue.assigneeAgentId;
    if (!agentId) continue;
    if (withChildren.has(key)) {
      sweep.openSubIssues += 1;
    } else if (issue.blockedBy.some((id) => openBlockers.has(id.toHexString()))) {
      sweep.openBlockers += 1;
    } else if (withWake.has(key)) {
      sweep.pendingWake += 1;
    } else if (withRun.has(key)) {
      sweep.recentRun += 1;
    } else {
      const idleLimit = limits.get(agentId.toHexString()) ?? 1;
      const streak = await idleStreak(collections, agentId, issue._id, idleLimit);
      if (streak.count >= idleLimit) {
        sweep.idle += 1;
      } else if (await requestWake(collections, agentId, issue._id, 'stall_watchdog')) {
        sweep.woken += 1;
      } else {
        sweep.pendingWake += 1;
      }
    }
  }
  return sweep;
}
