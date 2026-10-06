import { ObjectId } from 'mongodb';
import { FINISHED_RUN_STATUSES } from '@conclavix/core';
import type { Database, RunDoc } from '../../db.js';

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
  const recent = await collections.runs
    .find({
      agentId: run.agentId,
      issueId: run.issueId,
      status: { $in: [...FINISHED_RUN_STATUSES] },
    })
    .sort({ finishedAt: -1, _id: -1 })
    .limit(threshold)
    .toArray();
  if (recent.length < threshold || recent.some((item) => item.madeProgress !== false)) {
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
          '(no status change, no document revision, no new sub-issue). ' +
          'Check the issue and set the agent back to active when it can continue.',
        createdAt: now,
      },
      { session },
    );
    return true;
  });
}
