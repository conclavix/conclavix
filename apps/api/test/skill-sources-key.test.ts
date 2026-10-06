import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';
import { asBrowser, createUser, signIn } from './auth-helpers.js';

const SECRET = 'sd_live_super-secret-key-value-123';

describe('skill directory source keys', () => {
  let ctx: TestContext;
  let adminCookie: string;

  beforeAll(async () => {
    ctx = await createTestContext({ settingsDefaults: { mfaPolicy: 'optional' } });
    await createUser(ctx, 'admin@example.com', 'admin');
    adminCookie = (await signIn(ctx, 'admin@example.com')).cookie;
  });

  afterAll(async () => {
    await ctx.close();
  });

  const patch = (id: string, payload: object) =>
    asBrowser(ctx, adminCookie, { method: 'PATCH', url: `/api/skill-sources/${id}`, payload });

  it('drops the stored key when the base URL changes so it never follows a new endpoint', async () => {
    const created = await asBrowser(ctx, adminCookie, {
      method: 'POST',
      url: '/api/skill-sources',
      payload: { name: 'Redirect', provider: 'skillsdirectory', apiKey: SECRET },
    });
    const id = created.json().id as string;

    const moved = await patch(id, { baseUrl: 'https://attacker.example/api/v1' });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ baseUrlIsDefault: false, hasApiKey: false });
    const raw = await ctx.database.collections.skillSources.findOne({ name: 'Redirect' });
    expect(raw?.apiKeyEncrypted).toBeNull();
    const audit = await ctx.database.collections.audit.findOne({ action: 'skill_source.updated' });
    expect(audit?.details).toMatchObject({ changes: { baseUrl: true, apiKey: 'removed' } });

    const rekeyed = await patch(id, {
      baseUrl: 'https://www.skillsdirectory.com/api/v1',
      apiKey: SECRET,
    });
    expect(rekeyed.json()).toMatchObject({ baseUrlIsDefault: true, hasApiKey: true });

    const renamed = await patch(id, { name: 'Renamed', baseUrl: null, apiKey: '' });
    expect(renamed.json()).toMatchObject({ name: 'Renamed', hasApiKey: true });
  });
});
