import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateThemePreferences } from '../src/modules/users/me-routes.js';
import { createTestContext, type TestContext } from './helpers.js';
import { asBrowser, createUser, signIn } from './auth-helpers.js';

describe('sign-in', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext({ settingsDefaults: { mfaPolicy: 'optional' } });
    await createUser(ctx, 'ada@example.com', 'member');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('signs in with e-mail and password and sets an httpOnly lax session cookie', async () => {
    const { response, cookie } = await signIn(ctx, 'ada@example.com');
    expect(response.statusCode).toBe(200);
    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).not.toMatch(/Secure/);
    const me = await asBrowser(ctx, cookie, { method: 'GET', url: '/api/me' });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      kind: 'user',
      email: 'ada@example.com',
      role: 'member',
      via: 'session',
      preferences: { theme: { mode: 'system' } },
    });
  });

  it('reads and migrates a theme stored as a plain mode string', async () => {
    const id = await createUser(ctx, 'grace@example.com', 'viewer');
    const users = ctx.database.collections.users;
    await users.updateOne(
      { _id: new ObjectId(id) },
      { $set: { 'preferences.theme': 'dark' } as Record<string, unknown> },
    );
    const { cookie } = await signIn(ctx, 'grace@example.com');
    const me = await asBrowser(ctx, cookie, { method: 'GET', url: '/api/me' });
    expect(me.json()).toMatchObject({ preferences: { theme: { mode: 'dark' } } });
    expect(await migrateThemePreferences(ctx.database.collections)).toBe(1);
    expect((await users.findOne({ _id: new ObjectId(id) }))?.preferences).toEqual({
      theme: { mode: 'dark' },
    });
    expect(await migrateThemePreferences(ctx.database.collections)).toBe(0);
  });

  it('rejects a wrong password and audits the failure without the password', async () => {
    const { response, cookie } = await signIn(ctx, 'ada@example.com', 'wrong password 123');
    expect(response.statusCode).toBe(401);
    expect(cookie).toBe('');
    const entry = await ctx.database.collections.audit.findOne({ action: 'auth.sign_in_failed' });
    expect(entry).toMatchObject({ details: { email: 'ada@example.com' } });
    expect(JSON.stringify(entry)).not.toContain('wrong password');
  });

  it('has no open sign-up and hides unused better-auth endpoints', async () => {
    const signUp = await asBrowser(ctx, '', {
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email: 'eve@example.com', password: 'whatever-long-pass', name: 'Eve' },
    });
    expect(signUp.statusCode).toBe(404);
    const update = await asBrowser(ctx, '', {
      method: 'POST',
      url: '/api/auth/update-user',
      payload: { name: 'x' },
    });
    expect(update.statusCode).toBe(404);
    expect(await ctx.database.collections.users.countDocuments({ email: 'eve@example.com' })).toBe(
      0,
    );
  });

  it('rejects requests without credentials and with an unknown bearer token', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    const { cookie } = await signIn(ctx, 'ada@example.com');
    const forged = await asBrowser(ctx, cookie, {
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: 'Bearer cvx_pat_forged' },
    });
    expect(forged.statusCode).toBe(401);
  });

  it('updates the own name and theme preference', async () => {
    const { cookie } = await signIn(ctx, 'ada@example.com');
    const patched = await asBrowser(ctx, cookie, {
      method: 'PATCH',
      url: '/api/me',
      payload: { name: 'Ada L.', preferences: { theme: { template: 'atlas', mode: 'dark' } } },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      name: 'Ada L.',
      preferences: { theme: { template: 'atlas', mode: 'dark' } },
    });
    const templateOnly = await asBrowser(ctx, cookie, {
      method: 'PATCH',
      url: '/api/me',
      payload: { preferences: { theme: { template: 'neon' } } },
    });
    expect(templateOnly.json()).toMatchObject({ preferences: { theme: { template: 'neon' } } });
    expect(templateOnly.json().preferences.theme).not.toHaveProperty('mode');
    for (const theme of ['dark', { template: 'nope' }, { mode: 'dim' }, { mode: 'dark', x: 1 }]) {
      const invalid = await asBrowser(ctx, cookie, {
        method: 'PATCH',
        url: '/api/me',
        payload: { preferences: { theme } },
      });
      expect(invalid.statusCode, JSON.stringify(theme)).toBe(400);
    }
    const email = await asBrowser(ctx, cookie, {
      method: 'PATCH',
      url: '/api/me',
      payload: { email: 'other@example.com' },
    });
    expect(email.statusCode).toBe(400);
  });

  it('changes the own password through better-auth', async () => {
    await createUser(ctx, 'pw@example.com', 'viewer');
    const { cookie } = await signIn(ctx, 'pw@example.com');
    const changed = await asBrowser(ctx, cookie, {
      method: 'POST',
      url: '/api/auth/change-password',
      payload: {
        currentPassword: 'correct horse battery staple',
        newPassword: 'a brand new password',
      },
    });
    expect(changed.statusCode).toBe(200);
    expect((await signIn(ctx, 'pw@example.com')).response.statusCode).toBe(401);
    expect((await signIn(ctx, 'pw@example.com', 'a brand new password')).response.statusCode).toBe(
      200,
    );
  });

  it('blocks a banned user immediately and on the next sign-in', async () => {
    const id = await createUser(ctx, 'mallory@example.com', 'member');
    const { cookie } = await signIn(ctx, 'mallory@example.com');
    const ban = await ctx.request({ method: 'POST', url: `/api/users/${id}/ban` });
    expect(ban.statusCode).toBe(200);
    expect(ban.json()).toMatchObject({ banned: true });
    expect((await asBrowser(ctx, cookie, { method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    expect((await signIn(ctx, 'mallory@example.com')).response.statusCode).toBe(403);
    await ctx.request({ method: 'POST', url: `/api/users/${id}/unban` });
    expect((await signIn(ctx, 'mallory@example.com')).response.statusCode).toBe(200);
  });

  it('leaves /mcp on run tokens: a board session is no agent credential', async () => {
    const { cookie } = await signIn(ctx, 'ada@example.com');
    const response = await asBrowser(ctx, cookie, {
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('auth rate limits', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext({
      authRateLimit: true,
      settingsDefaults: { mfaPolicy: 'optional' },
    });
    await createUser(ctx, 'rate@example.com', 'viewer');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('limits sign-in attempts even with a session but not ordinary API calls', async () => {
    const { cookie } = await signIn(ctx, 'rate@example.com');
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const response = await asBrowser(ctx, cookie, {
        method: 'POST',
        url: '/api/auth/sign-in/email',
        payload: { email: 'rate@example.com', password: 'wrong password 123' },
      });
      statuses.push(response.statusCode);
    }
    expect(statuses).toContain(429);
    for (let i = 0; i < 30; i += 1) {
      const response = await asBrowser(ctx, cookie, { method: 'GET', url: '/api/me' });
      expect(response.statusCode).toBe(200);
    }
  });
});
