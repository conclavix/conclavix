import type { ObjectId } from 'mongodb';
import { CLOSED_ISSUE_STATUSES, FINISHED_RUN_STATUSES } from '@conclavix/core';
import type { AgentDoc, Collections, IssueDoc } from '../../db.js';
import { DAY_MS } from './time.js';
import type {
  AgentToday,
  BlockedIssue,
  BudgetHeldAgent,
  FailedRun,
  IssueRef,
  PausedAgent,
} from './types.js';

const LIST_LIMIT = 20;
const FAILED = ['failed', 'timed_out'] as const;
const LOOP_PAUSE_PREFIX = 'Agent paused:';

const issueRef = (doc: IssueDoc): IssueRef => ({
  issueId: doc._id.toHexString(),
  key: doc.key,
  title: doc.title,
  assigneeAgentId: doc.assigneeAgentId?.toHexString() ?? null,
  updatedAt: doc.updatedAt,
});

/** Map issue ids to keys for the given ids. */
export async function issueKeys(
  collections: Collections,
  ids: ObjectId[],
): Promise<Map<string, string>> {
  if (ids.length === 0) {
    return new Map();
  }
  const docs = await collections.issues
    .find({ _id: { $in: ids } }, { projection: { key: 1 } })
    .toArray();
  return new Map(docs.map((doc) => [doc._id.toHexString(), doc.key]));
}

/**
 * Paused agents with the likely reason: loop detection leaves a system comment on the
 * issue of the agent's last finished run; anything else was paused by the board.
 */
export async function pausedAgents(
  collections: Collections,
  agents: AgentDoc[],
): Promise<PausedAgent[]> {
  const paused = agents.filter((agent) => agent.status === 'paused');
  return Promise.all(
    paused.map(async (agent): Promise<PausedAgent> => {
      const base = {
        agentId: agent._id.toHexString(),
        name: agent.name,
        since: agent.updatedAt,
      };
      const last = await collections.runs.findOne(
        // Loop detection only pauses on issue runs; chat runs never pause an agent.
        {
          agentId: agent._id,
          issueId: { $type: 'objectId' },
          status: { $in: [...FINISHED_RUN_STATUSES] },
        },
        { sort: { finishedAt: -1, _id: -1 }, projection: { issueId: 1, createdAt: 1 } },
      );
      const lastIssueId = last?.issueId ?? null;
      const notice =
        last && lastIssueId
          ? await collections.comments.findOne({
              issueId: lastIssueId,
              'author.type': 'system',
              body: { $regex: `^${LOOP_PAUSE_PREFIX}` },
              createdAt: { $gte: last.createdAt },
            })
          : null;
      if (!last || !lastIssueId || !notice) {
        return { ...base, reason: 'manual', issueId: null, issueKey: null };
      }
      const issue = await collections.issues.findOne(
        { _id: lastIssueId },
        { projection: { key: 1 } },
      );
      return {
        ...base,
        reason: 'loop',
        issueId: lastIssueId.toHexString(),
        issueKey: issue?.key ?? null,
      };
    }),
  );
}

/** Active agents whose cost since UTC midnight reached their daily limit. */
export function budgetHeld(agents: AgentDoc[], today: AgentToday[]): BudgetHeldAgent[] {
  const cost = new Map(today.map((row) => [row.agentId, row.costUsd]));
  return agents
    .filter((agent) => agent.status === 'active')
    .map((agent) => ({
      agentId: agent._id.toHexString(),
      name: agent.name,
      costTodayUsd: cost.get(agent._id.toHexString()) ?? 0,
      limitUsd: agent.limits.maxCostPerDayUsd,
    }))
    .filter((row) => row.costTodayUsd >= row.limitUsd);
}

/** Runs that failed or timed out in the last 24 hours, newest first, plus their total count. */
export async function failedRuns(
  collections: Collections,
  agents: Map<string, AgentDoc>,
  now: Date,
): Promise<{ items: FailedRun[]; total: number }> {
  const filter = {
    status: { $in: [...FAILED] },
    finishedAt: { $gte: new Date(now.getTime() - DAY_MS) },
  };
  const [docs, total] = await Promise.all([
    collections.runs.find(filter).sort({ finishedAt: -1 }).limit(LIST_LIMIT).toArray(),
    collections.runs.countDocuments(filter),
  ]);
  const keys = await issueKeys(
    collections,
    docs.flatMap((doc) => (doc.issueId ? [doc.issueId] : [])),
  );
  const items = docs.map((doc) => {
    const agentId = doc.agentId.toHexString();
    const issueId = doc.issueId?.toHexString() ?? null;
    return {
      runId: doc._id.toHexString(),
      agentId,
      agentName: agents.get(agentId)?.name ?? 'deleted agent',
      issueId,
      chatId: doc.chatId?.toHexString() ?? null,
      issueKey: issueId ? (keys.get(issueId) ?? null) : null,
      status: doc.status,
      error: doc.error,
      finishedAt: doc.finishedAt,
    };
  });
  return { items, total };
}

/** Open issues with at least one open blocker. */
export async function blockedIssues(collections: Collections): Promise<BlockedIssue[]> {
  const closed = [...CLOSED_ISSUE_STATUSES];
  const rows = await collections.issues
    .aggregate<IssueDoc & { blockers: Pick<IssueDoc, '_id' | 'key' | 'status'>[] }>([
      { $match: { status: { $nin: closed }, 'blockedBy.0': { $exists: true } } },
      {
        $lookup: {
          from: collections.issues.collectionName,
          localField: 'blockedBy',
          foreignField: '_id',
          pipeline: [{ $match: { status: { $nin: closed } } }, { $project: { key: 1, status: 1 } }],
          as: 'blockers',
        },
      },
      { $match: { 'blockers.0': { $exists: true } } },
      { $sort: { updatedAt: 1 } },
      { $limit: LIST_LIMIT },
    ])
    .toArray();
  return rows.map((row) => ({
    ...issueRef(row),
    blockers: row.blockers.map((blocker) => ({
      issueId: blocker._id.toHexString(),
      key: blocker.key,
      status: blocker.status,
    })),
  }));
}

/** Issues waiting in review, longest waiting first. */
export async function inReview(collections: Collections): Promise<IssueRef[]> {
  const docs = await collections.issues
    .find({ status: 'in_review' })
    .sort({ updatedAt: 1 })
    .limit(LIST_LIMIT)
    .toArray();
  return docs.map(issueRef);
}
