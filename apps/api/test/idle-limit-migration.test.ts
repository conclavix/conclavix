import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentDoc } from '../src/db.js';
import { migrateIdleRunLimit } from '../src/modules/scheduler/limits-migration.js';
import { idleRunLimit } from '../src/modules/scheduler/loop-detection.js';
import { createTestContext, type TestContext } from './helpers.js';

describe('idle-run limit migration', () => {
  let ctx: TestContext;

  const rawAgent = (name: string, limits: Record<string, number>): AgentDoc =>
    ({
      _id: new ObjectId(),
      name,
      role: 'engineer',
      title: '',
      reportsTo: null,
      adapter: { type: 'claude_cli' },
      limits,
      instructions: '',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    }) as unknown as AgentDoc;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('converts the hourly value without weakening the loop guard and releases its wakes', async () => {
    const { collections } = ctx.database;
    const legacy = rawAgent('Legacy', {
      maxRunsPerIssuePerHour: 7,
      maxCostPerRunUsd: 2,
      maxCostPerDayUsd: 20,
    });
    const both = rawAgent('Both', {
      maxRunsPerIssuePerHour: 9,
      maxIdleRunsPerIssue: 3,
      maxCostPerRunUsd: 2,
      maxCostPerDayUsd: 20,
    });
    const current = rawAgent('Current', {
      maxIdleRunsPerIssue: 2,
      maxCostPerRunUsd: 2,
      maxCostPerDayUsd: 20,
    });
    const strict = rawAgent('Strict', {
      maxRunsPerIssuePerHour: 1,
      maxCostPerRunUsd: 2,
      maxCostPerDayUsd: 20,
    });
    await collections.agents.insertMany([legacy, both, current, strict]);
    expect(idleRunLimit(legacy)).toBe(2);
    expect(idleRunLimit(strict)).toBe(1);
    const wake = (deferReason: 'run_rate_limit' | 'daily_cost_limit') => ({
      _id: new ObjectId(),
      agentId: legacy._id,
      issueId: new ObjectId(),
      reason: 'comment' as const,
      createdAt: new Date(),
      processedAt: null,
      runId: null,
      skipReason: null,
      notBefore: new Date(Date.now() + 30 * 60_000),
      deferReason,
    });
    const hourly = wake('run_rate_limit');
    const daily = wake('daily_cost_limit');
    await collections.wakes.insertMany([hourly, daily]);

    expect(await migrateIdleRunLimit(collections)).toEqual({ agents: 3, wakes: 1 });
    const limitsOf = async (agent: AgentDoc) =>
      (await collections.agents.findOne({ _id: agent._id }))?.limits;
    expect(await limitsOf(legacy)).toEqual({
      maxIdleRunsPerIssue: 2,
      maxCostPerRunUsd: 2,
      maxCostPerDayUsd: 20,
    });
    expect(await limitsOf(both)).toEqual({
      maxIdleRunsPerIssue: 3,
      maxCostPerRunUsd: 2,
      maxCostPerDayUsd: 20,
    });
    expect((await limitsOf(current))?.maxIdleRunsPerIssue).toBe(2);
    expect((await limitsOf(strict))?.maxIdleRunsPerIssue).toBe(1);
    expect(await collections.wakes.findOne({ _id: hourly._id })).toMatchObject({
      notBefore: null,
      deferReason: null,
    });
    expect(await collections.wakes.findOne({ _id: daily._id })).toMatchObject({
      deferReason: 'daily_cost_limit',
    });

    expect(await migrateIdleRunLimit(collections)).toEqual({ agents: 0, wakes: 0 });
  });
});
