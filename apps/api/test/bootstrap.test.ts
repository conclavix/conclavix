import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFirstOwner } from '../src/modules/users/bootstrap.js';
import { AUTH_SECRET, BOARD_URL, createTestContext, type TestContext } from './helpers.js';
import { signIn } from './auth-helpers.js';
import { createAuthSystem } from '../src/modules/auth/system.js';

describe('first owner bootstrap', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext({ boardToken: undefined });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('creates the first owner with a generated password once and then refuses', async () => {
    const system = await createAuthSystem({
      database: ctx.database,
      secret: AUTH_SECRET,
      boardUrl: BOARD_URL,
      sessionTtlHours: 1,
      rateLimit: false,
      defaults: {
        instanceName: 'Test',
        mfaPolicy: 'optional',
        models: [],
        smtp: { host: null, port: 587, secure: false, user: null, pass: null, from: null },
      },
      log: ctx.app.log,
    });
    const { user, generatedPassword } = await createFirstOwner(system.users, {
      email: 'Root@Example.com',
      name: 'Root',
    });
    expect(user).toMatchObject({ email: 'root@example.com', role: 'owner' });
    expect(generatedPassword).toHaveLength(24);
    expect(
      (await signIn(ctx, 'root@example.com', generatedPassword ?? '')).response.statusCode,
    ).toBe(200);
    await expect(
      createFirstOwner(system.users, { email: 'second@example.com', name: 'Second' }),
    ).rejects.toThrow(/owner already exists/);
  });
});
