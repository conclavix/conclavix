import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';
import { asBrowser, createUser, signIn } from './auth-helpers.js';

describe('administration API', () => {
  let ctx: TestContext;
  let adminId: string;
  let memberId: string;
  let adminCookie: string;
  let memberCookie: string;

  beforeAll(async () => {
    ctx = await createTestContext({ settingsDefaults: { mfaPolicy: 'optional' } });
    adminId = await createUser(ctx, 'admin@example.com', 'admin');
    memberId = await createUser(ctx, 'member@example.com', 'member');
    await createUser(ctx, 'viewer@example.com', 'viewer');
    adminCookie = (await signIn(ctx, 'admin@example.com')).cookie;
    memberCookie = (await signIn(ctx, 'member@example.com')).cookie;
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('lists the fixed roles with capabilities and user counts for admins only', async () => {
    const banned = await createUser(ctx, 'banned@example.com', 'member');
    expect(
      (await ctx.request({ method: 'POST', url: `/api/users/${banned}/ban` })).statusCode,
    ).toBe(200);
    const response = await asBrowser(ctx, adminCookie, { method: 'GET', url: '/api/roles' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.capabilities.map((c: { key: string }) => c.key)).toEqual([
      'read',
      'self',
      'work',
      'agents',
      'users',
      'settings',
      'audit',
    ]);
    const byRole = Object.fromEntries(
      body.roles.map((role: { role: string }) => [role.role, role]),
    );
    expect(Object.keys(byRole)).toEqual(['owner', 'admin', 'member', 'viewer']);
    expect(byRole.viewer.capabilities).toEqual(['read', 'self']);
    expect(byRole.member.capabilities).toEqual(['read', 'self', 'work']);
    expect(byRole.admin.capabilities).toContain('settings');
    expect(byRole.member).toMatchObject({ users: 2, activeUsers: 1 });
    expect(byRole.admin).toMatchObject({ users: 1, activeUsers: 1 });
    expect(typeof byRole.owner.description).toBe('string');

    const member = await asBrowser(ctx, memberCookie, { method: 'GET', url: '/api/roles' });
    expect(member.statusCode).toBe(403);
  });

  it('reports the last successful sign-in per user', async () => {
    const list = await asBrowser(ctx, adminCookie, { method: 'GET', url: '/api/users' });
    const users = Object.fromEntries(
      list.json().items.map((user: { id: string }) => [user.id, user]),
    );
    expect(users[adminId].lastSignInAt).toEqual(expect.any(String));
    const viewer = list
      .json()
      .items.find((user: { email: string }) => user.email === 'viewer@example.com');
    expect(viewer.lastSignInAt).toBeNull();
  });

  it('filters the audit log by action, actor and time range', async () => {
    await asBrowser(ctx, adminCookie, {
      method: 'POST',
      url: `/api/users/${memberId}/reset-2fa`,
    });
    const get = (query: string) =>
      asBrowser(ctx, adminCookie, { method: 'GET', url: `/api/audit?${query}` });

    const byAction = (await get('action=user.mfa_reset,user.banned')).json().items;
    expect(byAction.map((entry: { action: string }) => entry.action).sort()).toEqual([
      'user.banned',
      'user.mfa_reset',
    ]);
    const byActor = (await get(`actor=${adminId}`)).json().items;
    expect(byActor.length).toBeGreaterThan(0);
    expect(
      byActor.every((entry: { actor: { userId?: string } }) => entry.actor.userId === adminId),
    ).toBe(true);
    const board = (await get('actor=board&action=user.created')).json().items;
    expect(board.length).toBe(4);

    const future = new Date(Date.now() + 60_000).toISOString();
    expect((await get(`from=${encodeURIComponent(future)}`)).json().items).toEqual([]);
    expect((await get(`to=${encodeURIComponent(future)}&limit=2`)).json()).toMatchObject({
      items: [expect.anything(), expect.anything()],
      nextCursor: expect.any(String),
    });
    expect((await get('action=DROP TABLE')).statusCode).toBe(400);
    expect((await get('actor=nobody')).statusCode).toBe(400);
  });

  it('never returns secrets or temporary passwords in audit entries', async () => {
    const created = await ctx.request({
      method: 'POST',
      url: '/api/users',
      payload: { email: 'temp@example.com', name: 'Temp', role: 'viewer' },
    });
    expect(created.json().delivery).toBe('temporary');
    const temporary = created.json().temporaryPassword as string;
    await ctx.request({
      method: 'PATCH',
      url: '/api/settings',
      payload: { smtp: { pass: 'audit-secret-pass' } },
    });
    const body = (await get()).body;
    expect(body).not.toContain(temporary);
    expect(body).not.toContain('audit-secret-pass');
    expect(body).not.toContain('correct horse');

    function get() {
      return asBrowser(ctx, adminCookie, { method: 'GET', url: '/api/audit?limit=200' });
    }
  });
});
