import { CLOSED_ISSUE_STATUSES } from '@conclavix/core';
import type { FindCursor, ObjectId } from 'mongodb';
import type { AgentDoc, Collections, IssueDoc } from '../../db.js';
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
  /** Left alone: an idle watchdog run would reach the idle-run limit; the heartbeat takes over. */
  idle: number;
}

type Skip = Exclude<keyof StallSweep, 'candidates' | 'woken'>;

const CHUNK = 200;

const hexSet = (values: readonly (ObjectId | null)[]): Set<string> =>
  new Set(values.flatMap((value) => (value ? [value.toHexString()] : [])));

/** Idle todo/in_progress issues of active agents enabled in their project, oldest change first. */
async function candidates(
  collections: Collections,
  cutoff: Date,
): Promise<{ agents: AgentDoc[]; cursor: FindCursor<IssueDoc> | null }> {
  const [disabled, agents] = await Promise.all([
    disabledAssignments(collections),
    collections.agents.find({ status: 'active' }).toArray(),
  ]);
  if (agents.length === 0) return { agents, cursor: null };
  const cursor = collections.issues
    .find({
      status: { $in: [...ACTIONABLE_STATUSES] },
      assigneeAgentId: { $in: agents.map((agent) => agent._id) },
      checkoutRunId: null,
      updatedAt: { $lt: cutoff },
      $or: [{ lastRunAt: null }, { lastRunAt: { $lt: cutoff } }],
      ...(disabled.length > 0 ? { $nor: disabled } : {}),
    })
    .sort({ updatedAt: 1, _id: 1 });
  return { agents, cursor };
}

/** Why an issue of `chunk` is left alone, by issue id (hex); issues not in the map may be woken. */
async function skipReasons(
  collections: Collections,
  chunk: readonly IssueDoc[],
  cutoff: Date,
): Promise<Map<string, Skip>> {
  const issueIds = chunk.map((issue) => issue._id);
  const open = { $nin: [...CLOSED_ISSUE_STATUSES] };
  const [parents, blockers, pending, runs] = await Promise.all([
    collections.issues.distinct('parentId', { parentId: { $in: issueIds }, status: open }),
    collections.issues.distinct('_id', {
      _id: { $in: chunk.flatMap((issue) => issue.blockedBy) },
      status: open,
    }),
    collections.wakes.distinct('issueId', { issueId: { $in: issueIds }, processedAt: null }),
    collections.runs.distinct('issueId', {
      issueId: { $in: issueIds },
      $or: [{ status: { $in: ['queued', 'running'] } }, { finishedAt: { $gte: cutoff } }],
    }),
  ]);
  const withChildren = hexSet(parents);
  const openBlockers = hexSet(blockers);
  const withWake = hexSet(pending);
  const withRun = hexSet(runs);
  const reasons = new Map<string, Skip>();
  for (const issue of chunk) {
    const key = issue._id.toHexString();
    if (withChildren.has(key)) reasons.set(key, 'openSubIssues');
    else if (issue.blockedBy.some((id) => openBlockers.has(id.toHexString())))
      reasons.set(key, 'openBlockers');
    else if (withWake.has(key)) reasons.set(key, 'pendingWake');
    else if (withRun.has(key)) reasons.set(key, 'recentRun');
  }
  return reasons;
}

/**
 * Find issues an agent could work on but where nothing happens, and queue one `stall_watchdog`
 * wake for each, at most `limit` per sweep. Candidates are `todo`/`in_progress` issues (never
 * `in_review`: those wait for the board, and the ones waiting for sub-issues or blockers are
 * handed back when those close) of an active agent enabled in the project, not checked out, with
 * no change and no run start within the interval. Left alone are issues with an open sub-issue or
 * blocker, a pending wake, or a queued, running or recently finished run. The watchdog also leaves
 * an issue alone when one more idle run would reach the agent's idle-run limit there, so a
 * watchdog run alone never reaches the idle backoff; an idle one still counts toward the streak
 * that later heartbeat runs continue. The filters run before the
 * limit, so issues left alone cannot crowd out stalled ones. The wakes pass the scheduler gates
 * like heartbeat wakes.
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
  const { agents, cursor } = await candidates(collections, cutoff);
  if (!cursor) return sweep;
  const limits = new Map(agents.map((agent) => [agent._id.toHexString(), idleRunLimit(agent)]));
  const wake = async (issue: IssueDoc): Promise<void> => {
    const agentId = issue.assigneeAgentId;
    if (!agentId) return;
    const idleLimit = limits.get(agentId.toHexString()) ?? 1;
    const streak = await idleStreak(collections, agentId, issue._id, idleLimit);
    if (streak.count + 1 >= idleLimit) sweep.idle += 1;
    else if (await requestWake(collections, agentId, issue._id, 'stall_watchdog')) sweep.woken += 1;
    else sweep.pendingWake += 1;
  };
  try {
    let chunk: IssueDoc[] = [];
    const flush = async (): Promise<void> => {
      const reasons = await skipReasons(collections, chunk, cutoff);
      for (const issue of chunk) {
        if (sweep.woken >= limit) return;
        const reason = reasons.get(issue._id.toHexString());
        if (reason) sweep[reason] += 1;
        else await wake(issue);
      }
      chunk = [];
    };
    for await (const issue of cursor) {
      sweep.candidates += 1;
      chunk.push(issue);
      if (chunk.length >= CHUNK) await flush();
      if (sweep.woken >= limit) break;
    }
    if (chunk.length > 0 && sweep.woken < limit) await flush();
  } finally {
    await cursor.close();
  }
  return sweep;
}
