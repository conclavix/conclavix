import type { ObjectId } from 'mongodb';
import { FINISHED_RUN_STATUSES } from '@conclavix/core';
import type { AgentDoc, Collections } from '../../db.js';
import { issueKeys } from './attention.js';
import type { ActivityItem } from './types.js';

const SNIPPET = 140;

const snippet = (text: string): string =>
  text.length > SNIPPET ? `${text.slice(0, SNIPPET - 3)}...` : text;

/** The newest `limit` finished runs, comments and issue openings/closings, merged by time. */
export async function recentActivity(
  collections: Collections,
  agents: Map<string, AgentDoc>,
  limit: number,
): Promise<ActivityItem[]> {
  const [runs, comments, closed, created] = await Promise.all([
    collections.runs
      .find({ status: { $in: [...FINISHED_RUN_STATUSES] }, finishedAt: { $ne: null } })
      .sort({ finishedAt: -1 })
      .limit(limit)
      .toArray(),
    collections.comments.find().sort({ createdAt: -1 }).limit(limit).toArray(),
    collections.issues
      .find({ closedAt: { $ne: null } })
      .sort({ closedAt: -1 })
      .limit(limit)
      .toArray(),
    collections.issues.find().sort({ createdAt: -1 }).limit(limit).toArray(),
  ]);
  // Chat runs have no issue.
  const ids: ObjectId[] = [...runs, ...comments].flatMap((doc) =>
    doc.issueId ? [doc.issueId] : [],
  );
  const keys = await issueKeys(collections, ids);
  for (const issue of [...closed, ...created]) {
    keys.set(issue._id.toHexString(), issue.key);
  }
  const agentName = (id: ObjectId): string => agents.get(id.toHexString())?.name ?? 'deleted agent';
  const issue = (id: ObjectId | null) => ({
    issueId: id?.toHexString() ?? null,
    issueKey: id ? (keys.get(id.toHexString()) ?? null) : null,
  });

  const items: ActivityItem[] = [
    ...runs.map((run) => ({
      kind: run.status === 'succeeded' ? ('run_finished' as const) : ('run_failed' as const),
      at: run.finishedAt ?? run.createdAt,
      ...issue(run.issueId),
      runId: run._id.toHexString(),
      agentId: run.agentId.toHexString(),
      text: `${agentName(run.agentId)} run ${run.status.replace('_', ' ')}`,
    })),
    ...comments.map((comment) => ({
      kind: 'comment' as const,
      at: comment.createdAt,
      ...issue(comment.issueId),
      runId: null,
      agentId: comment.author.type === 'agent' ? comment.author.agentId : null,
      text: snippet(comment.body),
    })),
    ...closed.map((doc) => ({
      kind: 'issue_closed' as const,
      at: doc.closedAt ?? doc.updatedAt,
      ...issue(doc._id),
      runId: null,
      agentId: doc.assigneeAgentId?.toHexString() ?? null,
      text: `${doc.title} marked ${doc.status}`,
    })),
    ...created.map((doc) => ({
      kind: 'issue_created' as const,
      at: doc.createdAt,
      ...issue(doc._id),
      runId: null,
      agentId: null,
      text: doc.title,
    })),
  ];
  return items.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}
