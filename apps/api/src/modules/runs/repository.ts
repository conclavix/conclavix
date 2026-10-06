import { ObjectId, type Filter } from 'mongodb';
import type { ListRunsQuery, Run, RunEventData } from '@conclavix/core';
import type { Collections, RunDoc } from '../../db.js';
import { notFound, unprocessable } from '../../errors.js';
import { isActionable, requestWake } from '../scheduler/wakes.js';
import { assertAgentEnabledInProject } from '../projects/agent-access.js';

const toRun = (doc: RunDoc): Run => ({
  id: doc._id.toHexString(),
  agentId: doc.agentId.toHexString(),
  issueId: doc.issueId.toHexString(),
  reason: doc.reason,
  status: doc.status,
  costUsd: doc.costUsd,
  maxCostPerRunUsd: doc.maxCostPerRunUsd,
  overBudget: doc.overBudget ?? false,
  madeProgress: doc.madeProgress,
  error: doc.error,
  code: doc.code ?? null,
  createdAt: doc.createdAt,
  startedAt: doc.startedAt,
  finishedAt: doc.finishedAt,
});

interface RunEventItem {
  seq: number;
  type: string;
  text: string;
  data?: RunEventData;
  at: Date;
}

/** Read access to runs, plus the board's manual wake. */
export class RunRepository {
  constructor(private readonly collections: Collections) {}

  async list(query: ListRunsQuery): Promise<{ items: Run[]; nextCursor: string | null }> {
    const filter: Filter<RunDoc> = {};
    if (query.agentId) {
      filter.agentId = new ObjectId(query.agentId);
    }
    if (query.issueId) {
      filter.issueId = new ObjectId(query.issueId);
    }
    if (query.status) {
      filter.status = { $in: query.status };
    }
    if (query.from || query.to) {
      filter.createdAt = {
        ...(query.from ? { $gte: query.from } : {}),
        ...(query.to ? { $lt: query.to } : {}),
      };
    }
    if (query.before) {
      filter._id = { $lt: new ObjectId(query.before) };
    }
    const docs = await this.collections.runs
      .find(filter)
      .sort({ _id: -1 })
      .limit(query.limit + 1)
      .toArray();
    const items = docs.slice(0, query.limit);
    const last = items.at(-1);
    return {
      items: items.map(toRun),
      nextCursor: docs.length > query.limit && last ? last._id.toHexString() : null,
    };
  }

  async get(id: ObjectId): Promise<Run> {
    const doc = await this.collections.runs.findOne({ _id: id });
    if (!doc) {
      throw notFound('Run');
    }
    return toRun(doc);
  }

  async events(runId: ObjectId, after: number): Promise<{ items: RunEventItem[] }> {
    await this.get(runId);
    const docs = await this.collections.runEvents
      .find({ runId, seq: { $gt: after } })
      .sort({ seq: 1 })
      .limit(500)
      .toArray();
    return {
      items: docs.map(({ seq, type, text, data, at }) => ({
        seq,
        type,
        text,
        ...(data ? { data } : {}),
        at,
      })),
    };
  }

  async wake(agentId: ObjectId, issueId: ObjectId): Promise<{ queued: boolean }> {
    const [agent, issue] = await Promise.all([
      this.collections.agents.findOne({ _id: agentId }),
      this.collections.issues.findOne({ _id: issueId }),
    ]);
    if (!agent) {
      throw notFound('Agent');
    }
    if (!issue) {
      throw unprocessable('issueId refers to an issue that does not exist');
    }
    if (!issue.assigneeAgentId?.equals(agentId) || !isActionable(issue)) {
      throw unprocessable('the issue must be assigned to this agent and in todo or in_progress');
    }
    await assertAgentEnabledInProject(this.collections, agentId, issue.projectId);
    return { queued: await requestWake(this.collections, agentId, issueId, 'manual') };
  }
}
