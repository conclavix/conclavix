import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunDoc } from '../src/db.js';
import { createTestContext, type TestContext } from './helpers.js';

describe('GET /api/runs history filters', () => {
  let ctx: TestContext;
  const agentId = new ObjectId();
  const issueId = new ObjectId();

  const run = (day: number, status: RunDoc['status']): RunDoc => ({
    _id: new ObjectId(),
    agentId,
    issueId,
    reason: 'manual',
    status,
    costUsd: 0,
    maxCostPerRunUsd: 1,
    overBudget: false,
    progressAtStart: 0,
    madeProgress: null,
    error: null,
    createdAt: new Date(Date.UTC(2026, 9, day, 12)),
    startedAt: null,
    finishedAt: null,
    tokenHash: null,
    tokenExpiresAt: null,
  });

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.database.collections.runs.insertMany([
      run(1, 'succeeded'),
      run(2, 'failed'),
      run(3, 'succeeded'),
      run(4, 'succeeded'),
      run(5, 'running'),
    ]);
  });

  afterAll(async () => {
    await ctx.close();
  });

  const list = async (query: string) =>
    (await ctx.request({ method: 'GET', url: `/api/runs?${query}` })).json() as {
      items: { createdAt: string; status: string }[];
      nextCursor: string | null;
    };

  it('filters by a half-open createdAt range combined with status', async () => {
    const page = await list('from=2026-10-02&to=2026-10-05&status=succeeded,failed');
    expect(page.items.map((item) => item.createdAt.slice(0, 10))).toEqual([
      '2026-10-04',
      '2026-10-03',
      '2026-10-02',
    ]);
  });

  it('pages through filtered results with the cursor', async () => {
    const first = await list(`agentId=${agentId.toHexString()}&status=succeeded&limit=2`);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await list(
      `agentId=${agentId.toHexString()}&status=succeeded&limit=2&before=${first.nextCursor}`,
    );
    expect(second.items.map((item) => item.createdAt.slice(0, 10))).toEqual(['2026-10-01']);
    expect(second.nextCursor).toBeNull();
  });

  it('rejects malformed dates', async () => {
    const response = await ctx.request({ method: 'GET', url: '/api/runs?from=yesterday' });
    expect(response.statusCode).toBe(400);
  });
});
