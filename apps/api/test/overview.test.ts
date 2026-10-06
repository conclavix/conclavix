import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentDoc, IssueDoc, RunDoc } from '../src/db.js';
import { recentActivity } from '../src/modules/overview/activity.js';
import { OverviewService } from '../src/modules/overview/service.js';
import type { Overview } from '../src/modules/overview/types.js';
import { createTestContext, type TestContext } from './helpers.js';

const NOW = new Date('2026-10-04T10:00:00Z');
const at = (iso: string): Date => new Date(iso);

describe('overview', () => {
  let ctx: TestContext;
  let overview: Overview;
  const projectId = new ObjectId();
  let issueNumber = 0;

  const agent = async (name: string, status: AgentDoc['status'], maxCostPerDayUsd: number) => {
    const doc: AgentDoc = {
      _id: new ObjectId(),
      name,
      role: 'engineer',
      title: '',
      reportsTo: null,
      adapter: { type: 'claude_cli' },
      limits: { maxIdleRunsPerIssue: 4, maxCostPerRunUsd: 5, maxCostPerDayUsd },
      instructions: '',
      status,
      createdAt: at('2026-09-01T00:00:00Z'),
      updatedAt: at('2026-10-04T08:10:00Z'),
    };
    await ctx.database.collections.agents.insertOne(doc);
    return doc;
  };

  const issue = async (fields: Partial<IssueDoc>) => {
    issueNumber += 1;
    const doc: IssueDoc = {
      _id: new ObjectId(),
      projectId,
      key: `OV-${issueNumber}`,
      number: issueNumber,
      title: `issue ${issueNumber}`,
      description: '',
      status: 'todo',
      priority: 'medium',
      parentId: null,
      assigneeAgentId: null,
      blockedBy: [],
      labels: [],
      createdAt: at('2026-09-15T00:00:00Z'),
      updatedAt: at('2026-10-01T00:00:00Z'),
      closedAt: null,
      checkoutRunId: null,
      progress: 0,
      lastRunAt: null,
      ...fields,
    };
    await ctx.database.collections.issues.insertOne(doc);
    return doc;
  };

  const run = async (owner: AgentDoc, on: IssueDoc, fields: Partial<RunDoc>) => {
    const createdAt = fields.createdAt ?? NOW;
    await ctx.database.collections.runs.insertOne({
      _id: new ObjectId(),
      agentId: owner._id,
      issueId: on._id,
      reason: 'assigned',
      status: 'succeeded',
      costUsd: 0,
      maxCostPerRunUsd: 5,
      overBudget: false,
      progressAtStart: 0,
      madeProgress: true,
      error: null,
      startedAt: createdAt,
      finishedAt: new Date(createdAt.getTime() + 60_000),
      tokenHash: null,
      tokenExpiresAt: null,
      ...fields,
      createdAt,
    });
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    const alice = await agent('alice', 'active', 5);
    const bob = await agent('bob', 'paused', 10);
    await agent('carol', 'paused', 10);

    const blocker = await issue({ status: 'in_progress' });
    const blocked = await issue({ blockedBy: [blocker._id], assigneeAgentId: bob._id });
    const doneBlocker = await issue({ status: 'done', closedAt: at('2026-09-20T12:00:00Z') });
    await issue({ blockedBy: [doneBlocker._id] });
    await issue({ status: 'in_review' });
    await issue({ status: 'done', closedAt: at('2026-10-04T05:00:00Z') });
    await issue({ status: 'done', closedAt: at('2026-09-30T05:00:00Z') });

    await run(alice, blocker, { createdAt: at('2026-10-04T00:30:00Z'), costUsd: 1 });
    await run(alice, blocker, {
      createdAt: at('2026-10-04T09:00:00Z'),
      costUsd: 4.5,
      status: 'failed',
      error: 'adapter exited with code 1',
    });
    await run(alice, blocker, { createdAt: at('2026-10-03T23:59:59Z'), costUsd: 2 });
    await run(alice, blocker, { createdAt: at('2026-09-21T00:00:00Z'), costUsd: 0.5 });
    await run(alice, blocker, { createdAt: at('2026-09-20T23:59:59Z'), costUsd: 9 });
    await run(bob, blocked, {
      createdAt: at('2026-10-03T08:00:00Z'),
      costUsd: 0.25,
      status: 'timed_out',
    });
    await run(bob, blocked, {
      createdAt: at('2026-10-04T08:00:00Z'),
      costUsd: 0.3,
      madeProgress: false,
    });
    await ctx.database.collections.comments.insertOne({
      _id: new ObjectId(),
      issueId: blocked._id,
      author: { type: 'system' },
      body: 'Agent paused: its last 3 runs on this issue made no progress.',
      createdAt: at('2026-10-04T08:01:00Z'),
    });

    overview = await new OverviewService(ctx.database.collections, () => NOW).get({ days: 14 });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('buckets runs and cost by UTC day and fills empty days', () => {
    const days = overview.costPerDay;
    expect(days).toHaveLength(14);
    expect(days[0]).toEqual({ date: '2026-09-21', runs: 1, failed: 0, costUsd: 0.5 });
    expect(days[12]).toEqual({ date: '2026-10-03', runs: 2, failed: 1, costUsd: 2.25 });
    expect(days[13]).toMatchObject({ date: '2026-10-04', runs: 3, failed: 1 });
    expect(days[13]?.costUsd).toBeCloseTo(5.8);
    expect(days[5]).toEqual({ date: '2026-09-26', runs: 0, failed: 0, costUsd: 0 });
  });

  it('reports KPIs for today', () => {
    expect(overview.kpis).toMatchObject({
      runsToday: 3,
      failedToday: 1,
      dailyBudgetUsd: 5,
      issuesDoneToday: 1,
      issuesDone7d: 2,
      activeAgents: 1,
      totalAgents: 3,
      pendingWakes: 0,
    });
    expect(overview.kpis.costTodayUsd).toBeCloseTo(5.8);
    expect(overview.runsPerAgentToday.map((row) => [row.name, row.runs])).toEqual([
      ['alice', 2],
      ['bob', 1],
    ]);
    expect(overview.issuesByStatus).toMatchObject({ todo: 2, in_progress: 1, done: 3 });
  });

  it('tells loop pauses from manual pauses', () => {
    const paused = Object.fromEntries(overview.attention.pausedAgents.map((a) => [a.name, a]));
    expect(paused['bob']).toMatchObject({ reason: 'loop', issueKey: 'OV-2' });
    expect(paused['carol']).toMatchObject({ reason: 'manual', issueKey: null });
  });

  it('lists budget-held agents, failures of the last 24 h and open blockers', () => {
    expect(overview.attention.budgetHeld).toEqual([
      expect.objectContaining({ name: 'alice', limitUsd: 5 }),
    ]);
    expect(overview.attention.failedRuns24h).toBe(1);
    expect(overview.attention.failedRuns[0]).toMatchObject({
      agentName: 'alice',
      issueKey: 'OV-1',
      status: 'failed',
      error: 'adapter exited with code 1',
    });
    expect(overview.attention.blockedIssues.map((i) => i.key)).toEqual(['OV-2']);
    expect(overview.attention.blockedIssues[0]?.blockers).toEqual([
      expect.objectContaining({ key: 'OV-1', status: 'in_progress' }),
    ]);
    expect(overview.attention.inReview.map((i) => i.key)).toEqual(['OV-5']);
  });

  it('merges recent activity newest first', () => {
    const times = overview.activity.map((item) => new Date(item.at).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(overview.activity[0]).toMatchObject({ kind: 'run_failed', issueKey: 'OV-1' });
  });

  it('selects activity by createdAt before limiting candidates', async () => {
    const newest = await issue({ createdAt: at('2026-10-05T12:00:00Z') });
    const older = await issue({ createdAt: at('2026-10-05T10:00:00Z') });
    const collections = ctx.database.collections;
    try {
      // The older comment and issue have greater ObjectIds.
      await collections.comments.insertMany([
        {
          _id: new ObjectId(),
          issueId: newest._id,
          author: { type: 'system' },
          body: 'newest',
          createdAt: at('2026-10-05T13:00:00Z'),
        },
        {
          _id: new ObjectId(),
          issueId: older._id,
          author: { type: 'system' },
          body: 'older',
          createdAt: at('2026-10-05T11:00:00Z'),
        },
      ]);
      expect(await recentActivity(collections, new Map(), 1)).toEqual([
        expect.objectContaining({ kind: 'comment', text: 'newest' }),
      ]);
      await collections.comments.deleteMany({ issueId: { $in: [newest._id, older._id] } });
      expect(await recentActivity(collections, new Map(), 1)).toEqual([
        expect.objectContaining({ kind: 'issue_created', issueId: newest._id.toHexString() }),
      ]);
      for (const collection of [collections.comments, collections.issues]) {
        const indexes = await collection.listIndexes().toArray();
        expect(indexes.some((index) => JSON.stringify(index.key) === '{"createdAt":-1}')).toBe(
          true,
        );
      }
    } finally {
      await collections.comments.deleteMany({ issueId: { $in: [newest._id, older._id] } });
      await collections.issues.deleteMany({ _id: { $in: [newest._id, older._id] } });
    }
  });

  it('serves the overview over HTTP and validates the query', async () => {
    const ok = await ctx.request({ method: 'GET', url: '/api/overview?days=7' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ timezone: 'UTC', days: 7 });
    expect(ok.json().costPerDay).toHaveLength(7);
    const bad = await ctx.request({ method: 'GET', url: '/api/overview?days=0' });
    expect(bad.statusCode).toBe(400);
    const unknown = await ctx.request({ method: 'GET', url: '/api/overview?foo=1' });
    expect(unknown.statusCode).toBe(400);
  });
});
