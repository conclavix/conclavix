import { ObjectId } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentDoc } from '../src/db.js';
import { migrateReportsToLinks } from '../src/modules/org/migration.js';
import { createTestContext, type TestContext } from './helpers.js';

describe('reportsTo migration', () => {
  let ctx: TestContext;

  const rawAgent = (name: string, reportsTo: ObjectId | null): AgentDoc => ({
    _id: new ObjectId(),
    name,
    role: name.toLowerCase(),
    title: '',
    reportsTo,
    adapter: { type: 'claude_cli' },
    limits: { maxIdleRunsPerIssue: 4, maxCostPerRunUsd: 2, maxCostPerDayUsd: 20 },
    instructions: '',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const links = async () =>
    (await ctx.database.collections.agentLinks.find().toArray())
      .map((link) => `${link.from.toHexString()} ${link.type} ${link.to.toHexString()}`)
      .sort();

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('converts an existing tree once, idempotently, and then bootstraps the lead', async () => {
    const { collections } = ctx.database;
    expect(await migrateReportsToLinks(ctx.database)).toBeNull();
    await collections.org.updateOne({ _id: 'org' }, { $unset: { linksMigratedAt: '' } });

    const ceo = rawAgent('CEO', null);
    const cto = rawAgent('CTO', ceo._id);
    const dev = rawAgent('Dev', cto._id);
    await collections.agents.insertMany([ceo, cto, dev]);

    const results = await Promise.all([
      migrateReportsToLinks(ctx.database),
      migrateReportsToLinks(ctx.database),
    ]);
    expect(results.sort()).toEqual([2, null]);
    const id = (agent: AgentDoc) => agent._id.toHexString();
    expect(await links()).toEqual(
      [
        `${id(ceo)} delegates ${id(cto)}`,
        `${id(cto)} reports ${id(ceo)}`,
        `${id(cto)} delegates ${id(dev)}`,
        `${id(dev)} reports ${id(cto)}`,
      ].sort(),
    );

    await collections.agentLinks.deleteOne({ from: cto._id, to: dev._id, type: 'delegates' });
    expect(await migrateReportsToLinks(ctx.database)).toBeNull();
    expect(await links()).toHaveLength(3);

    const org = (await ctx.request({ method: 'GET', url: '/api/org' })).json();
    expect(org.leadAgentId).toBeNull();
    expect(org.leadCandidates.map((item: { name: string }) => item.name)).toEqual(['CEO', 'Dev']);
  });

  it('picks the single root of a migrated tree as lead on first read', async () => {
    const { collections } = ctx.database;
    await collections.org.updateOne({ _id: 'org' }, { $unset: { linksMigratedAt: '' } });
    const ceo = rawAgent('CEO', null);
    await collections.agents.insertMany([ceo, rawAgent('CTO', ceo._id)]);
    expect(await migrateReportsToLinks(ctx.database)).toBe(1);

    const org = (await ctx.request({ method: 'GET', url: '/api/org' })).json();
    expect(org.leadAgentId).toBe(ceo._id.toHexString());
  });
});
