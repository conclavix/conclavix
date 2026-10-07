import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureSecretIndexes } from '../src/db/secrets.js';
import { createTestContext, type TestContext } from './helpers.js';

describe('secret indexes', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('replaces the full unique indexes of the first release with partial ones', async () => {
    const { secrets } = ctx.database.collections;
    for (const name of ['secret_env_unique', 'secret_name_unique']) await secrets.dropIndex(name);
    await secrets.createIndex({ projectId: 1, envName: 1 }, { unique: true });
    await ensureSecretIndexes(ctx.database.collections);
    await ensureSecretIndexes(ctx.database.collections);
    const names = (await secrets.indexes()).map((index) => index.name);
    expect(names).not.toContain('projectId_1_envName_1');
    expect(names).toEqual(expect.arrayContaining(['secret_env_unique', 'secret_connection_key']));
    // Two instance-connection credentials (no project, no variable) no longer collide.
    const entry = () => ({
      _id: new ObjectId(),
      projectId: null,
      name: `c-${new ObjectId().toHexString()}:A`,
      envName: null,
      valueEncrypted: 'x',
      agentIds: [],
      connectionId: new ObjectId(),
      credentialKey: 'A',
      createdAt: new Date(),
      updatedAt: new Date(),
      lastUsedAt: null,
      lastUsedRunId: null,
    });
    await expect(secrets.insertMany([entry(), entry()])).resolves.toBeDefined();
  });
});
