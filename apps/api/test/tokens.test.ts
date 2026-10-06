import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BOARD_TOKEN, createTestContext, type TestContext } from './helpers.js';
import { asBrowser, createUser, signIn } from './auth-helpers.js';

describe('personal API tokens and the board token', () => {
  let ctx: TestContext;
  let viewerCookie: string;

  const bearer = (token: string, method: 'GET' | 'POST', url: string, payload?: object) =>
    ctx.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload } : {}),
    });

  beforeAll(async () => {
    ctx = await createTestContext({ settingsDefaults: { mfaPolicy: 'optional' } });
    await createUser(ctx, 'viewer@example.com', 'viewer');
    viewerCookie = (await signIn(ctx, 'viewer@example.com')).cookie;
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('creates a token shown once, stores only its hash and acts with the user role', async () => {
    const created = await asBrowser(ctx, viewerCookie, {
      method: 'POST',
      url: '/api/me/tokens',
      payload: { name: 'ci script', expiresInDays: 30 },
    });
    expect(created.statusCode).toBe(201);
    const { token, id, prefix } = created.json();
    expect(token).toMatch(/^cvx_pat_/);
    expect(token.startsWith(prefix)).toBe(true);
    const stored = await ctx.database.collections.apiTokens.findOne({});
    expect(JSON.stringify(stored)).not.toContain(token);

    const me = await bearer(token, 'GET', '/api/me');
    expect(me.json()).toMatchObject({ email: 'viewer@example.com', via: 'token' });
    expect((await bearer(token, 'GET', '/api/projects')).statusCode).toBe(200);
    expect(
      (await bearer(token, 'POST', '/api/projects', { key: 'TK', name: 'Token' })).statusCode,
    ).toBe(403);
    const chained = await bearer(token, 'POST', '/api/me/tokens', { name: 'chain' });
    expect(chained.statusCode).toBe(403);
    expect(chained.json()).toMatchObject({ error: 'session_required' });

    const list = await asBrowser(ctx, viewerCookie, { method: 'GET', url: '/api/me/tokens' });
    expect(list.json().items).toHaveLength(1);
    expect(JSON.stringify(list.json())).not.toContain(token);

    const revoked = await asBrowser(ctx, viewerCookie, {
      method: 'DELETE',
      url: `/api/me/tokens/${id}`,
    });
    expect(revoked.statusCode).toBe(204);
    expect((await bearer(token, 'GET', '/api/projects')).statusCode).toBe(401);
    const actions = (await ctx.database.collections.audit.find({}).toArray()).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['token.created', 'token.revoked']));
  });

  it('rejects expired tokens and tokens of banned users', async () => {
    const { token } = (
      await asBrowser(ctx, viewerCookie, {
        method: 'POST',
        url: '/api/me/tokens',
        payload: { name: 'short' },
      })
    ).json();
    expect((await bearer(token, 'GET', '/api/projects')).statusCode).toBe(200);
    await ctx.database.collections.apiTokens.updateMany({}, { $set: { expiresAt: new Date(1) } });
    expect((await bearer(token, 'GET', '/api/projects')).statusCode).toBe(401);
    await ctx.database.collections.apiTokens.updateMany({}, { $set: { expiresAt: null } });
    const user = await ctx.database.collections.users.findOne({ email: 'viewer@example.com' });
    await ctx.request({ method: 'POST', url: `/api/users/${user?._id.toHexString()}/ban` });
    expect((await bearer(token, 'GET', '/api/projects')).statusCode).toBe(401);
  });

  it('keeps the board token working as a break-glass owner', async () => {
    const response = await bearer(BOARD_TOKEN, 'GET', '/api/settings');
    expect(response.statusCode).toBe(200);
    expect((await bearer(BOARD_TOKEN, 'GET', '/api/me')).json()).toMatchObject({
      kind: 'board',
      role: 'owner',
    });
  });

  it('creates and revokes a token only together with its audit entry', async () => {
    const audit = ctx.database.collections.audit;
    const tokensCol = ctx.database.collections.apiTokens;
    await createUser(ctx, 'atomic@example.com', 'viewer');
    const { cookie } = await signIn(ctx, 'atomic@example.com');
    const created = await asBrowser(ctx, cookie, {
      method: 'POST',
      url: '/api/me/tokens',
      payload: { name: 'kept' },
    });
    expect(created.statusCode).toBe(201);
    const tokenCount = await tokensCol.countDocuments();
    const auditCount = await audit.countDocuments();
    const insertOne = audit.insertOne.bind(audit);
    const spy = vi.spyOn(audit, 'insertOne').mockImplementation(async (...args) => {
      await insertOne(...args);
      throw new Error('audit failed after insert');
    });
    try {
      const create = await asBrowser(ctx, cookie, {
        method: 'POST',
        url: '/api/me/tokens',
        payload: { name: 'never stored' },
      });
      expect(create.statusCode).toBe(500);
      expect(create.body).not.toContain('cvx_pat_');
      const revoke = await asBrowser(ctx, cookie, {
        method: 'DELETE',
        url: `/api/me/tokens/${created.json().id}`,
      });
      expect(revoke.statusCode).toBe(500);
      expect(await tokensCol.countDocuments()).toBe(tokenCount);
      expect(await audit.countDocuments()).toBe(auditCount);
      expect((await bearer(created.json().token, 'GET', '/api/me')).statusCode).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('without a board token', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext({ boardToken: undefined });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('rejects the former board token', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: `Bearer ${BOARD_TOKEN}` },
    });
    expect(response.statusCode).toBe(401);
  });
});
