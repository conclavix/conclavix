import { ObjectId, type ClientSession } from 'mongodb';
import { DEFAULT_MAX_IDLE_RUNS_PER_ISSUE, FINISHED_RUN_STATUSES } from '@conclavix/core';
import type { AgentDoc, Collections, Database, RunDoc } from '../../db.js';

/**
 * The agent's idle-run limit. Agents not yet migrated still carry the limit under its old name,
 * which the scheduler process may read before the API has migrated them.
 */
export function idleRunLimit(agent: Pick<AgentDoc, 'limits'>): number {
  const limits = agent.limits as Partial<AgentDoc['limits']> & { maxRunsPerIssuePerHour?: number };
  return (
    limits.maxIdleRunsPerIssue ?? limits.maxRunsPerIssuePerHour ?? DEFAULT_MAX_IDLE_RUNS_PER_ISSUE
  );
}

/**
 * Number of idle runs after which the agent is paused: the backoff limit plus
 * `idleRunsAfterBackoff` further runs, each of them started only after a backoff.
 */
export const pauseThreshold = (agent: Pick<AgentDoc, 'limits'>, idleRunsAfterBackoff: number) =>
  idleRunLimit(agent) + idleRunsAfterBackoff;

/**
 * Whether a finished run made progress: it raised the issue's progress counter (status change,
 * document revision, new sub-issue, reopening) or it was a coding run whose commits reached the
 * project repository.
 */
export function runMadeProgress(
  run: Pick<RunDoc, 'progressAtStart' | 'code'>,
  issueProgress: number | undefined,
): boolean {
  if ((issueProgress ?? run.progressAtStart) > run.progressAtStart) return true;
  const code = run.code;
  return Boolean(code?.synced && code.head !== null && code.head !== code.base);
}

export interface IdleStreak {
  /** Consecutive finished runs without progress, newest first, capped at the requested limit. */
  count: number;
  /** When the newest of them finished; null without idle runs. */
  lastFinishedAt: Date | null;
}

/**
 * Count the agent's consecutive finished runs on the issue that made no progress, starting at the
 * newest one. A run with progress (or one finished before progress was recorded) ends the streak.
 */
export async function idleStreak(
  collections: Collections,
  agentId: ObjectId,
  issueId: ObjectId,
  limit: number,
  session?: ClientSession,
): Promise<IdleStreak> {
  const recent = await collections.runs
    .find(
      { agentId, issueId, status: { $in: [...FINISHED_RUN_STATUSES] } },
      { projection: { madeProgress: 1, finishedAt: 1 }, ...(session ? { session } : {}) },
    )
    .sort({ finishedAt: -1, _id: -1 })
    .limit(limit)
    .toArray();
  let count = 0;
  while (count < recent.length && recent[count]?.madeProgress === false) count += 1;
  return { count, lastFinishedAt: count > 0 ? (recent[0]?.finishedAt ?? null) : null };
}

/**
 * Pause the agent when its last `threshold` finished runs on the issue changed nothing,
 * and tell the board on the issue. Returns true if the agent was paused.
 */
export async function pauseOnLoop(
  database: Database,
  run: RunDoc,
  threshold: number,
  now: Date,
): Promise<boolean> {
  const { collections } = database;
  const streak = await idleStreak(collections, run.agentId, run.issueId, threshold);
  if (streak.count < threshold) {
    return false;
  }
  return database.inTransaction(async (session) => {
    const paused = await collections.agents.updateOne(
      { _id: run.agentId, status: 'active' },
      { $set: { status: 'paused', updatedAt: now } },
      { session },
    );
    if (paused.modifiedCount !== 1) {
      return false;
    }
    await collections.comments.insertOne(
      {
        _id: new ObjectId(),
        issueId: run.issueId,
        author: { type: 'system' },
        body:
          `Agent paused: its last ${threshold} runs on this issue made no progress ` +
          '(no status change, no document revision, no new sub-issue, no synced commit). ' +
          'Check the issue and set the agent back to active when it can continue.',
        createdAt: now,
      },
      { session },
    );
    return true;
  });
}
