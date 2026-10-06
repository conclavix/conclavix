import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROUTE_PERMISSIONS } from '../src/modules/auth/permissions.js';
import { createTestContext, type TestContext } from './helpers.js';
import { asBrowser, createUser, signIn } from './auth-helpers.js';
import { multipartBody, solidPng } from './fixtures/images.js';

type Role = 'owner' | 'admin' | 'member' | 'viewer';
const ROLES: Role[] = ['owner', 'admin', 'member', 'viewer'];

describe('roles and permissions', () => {
  let ctx: TestContext;
  const cookies = {} as Record<Role, string>;
  const ids = {} as Record<Role, string>;
  let projectId: string;
  let agentId: string;

  const as = (
    role: Role,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) => asBrowser(ctx, cookies[role], { method, url, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    ctx = await createTestContext({ settingsDefaults: { mfaPolicy: 'optional' } });
    for (const role of ROLES) {
      ids[role] = await createUser(ctx, `${role}@example.com`, role);
      cookies[role] = (await signIn(ctx, `${role}@example.com`)).cookie;
    }
    projectId = (
      await ctx.request({
        method: 'POST',
        url: '/api/projects',
        payload: { key: 'RM', name: 'Roles' },
      })
    ).json().id;
    agentId = (
      await ctx.request({
        method: 'POST',
        url: '/api/agents',
        payload: { name: 'Ceo', role: 'ceo', title: 'CEO', adapter: { type: 'claude_cli' } },
      })
    ).json().id;
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('maps every permission entry to a registered route', () => {
    for (const key of Object.keys(ROUTE_PERMISSIONS)) {
      const [method, url] = key.split(' ') as [string, string];
      expect(ctx.app.hasRoute({ method: method as 'GET', url }), key).toBe(true);
    }
  });

  it.each([
    ['GET', '/api/projects', ['owner', 'admin', 'member', 'viewer']],
    ['POST', '/api/issues', ['owner', 'admin', 'member']],
    ['POST', '/api/memories', ['owner', 'admin', 'member']],
    ['POST', '/api/agents', ['owner', 'admin']],
    ['GET', '/api/users', ['owner', 'admin']],
    ['GET', '/api/users/names', ['owner', 'admin', 'member', 'viewer']],
    ['GET', '/api/settings', ['owner', 'admin']],
    ['GET', '/api/audit', ['owner', 'admin']],
    ['GET', '/api/models', ['owner', 'admin', 'member', 'viewer']],
    ['GET', '/api/overview', ['owner', 'admin', 'member', 'viewer']],
    ['GET', '/api/org-graph', ['owner', 'admin', 'member', 'viewer']],
    ['GET', '/api/skills', ['owner', 'admin', 'member', 'viewer']],
    ['POST', '/api/skills', ['owner', 'admin']],
  ] as const)('%s %s is allowed for %j', async (method, url, allowed) => {
    for (const role of ROLES) {
      const payload =
        url === '/api/issues'
          ? { projectId, title: `by ${role}` }
          : url === '/api/memories'
            ? { scope: 'global', title: `note ${role}`, body: 'b' }
            : url === '/api/agents'
              ? { name: `A${role}`, role: 'dev', title: 'Dev', adapter: { type: 'claude_cli' } }
              : url === '/api/skills'
                ? { name: `skill-${role}`, description: 'Role check', body: 'b' }
                : undefined;
      const response = await as(role, method, url, payload);
      const ok = (allowed as readonly string[]).includes(role);
      expect(response.statusCode < 300, `${role} ${method} ${url}: ${response.statusCode}`).toBe(
        ok,
      );
      if (!ok) expect(response.statusCode).toBe(403);
    }
  });

  it('lets every role read a board and only members and above replace it', async () => {
    const url = `/api/projects/${projectId}/board`;
    for (const role of ROLES) {
      const response = await as(role, 'GET', url);
      expect(response.statusCode).toBe(200);
      expect((await asBrowser(ctx, cookies[role], { method: 'HEAD', url })).statusCode).toBe(200);
      const { revision, columns } = response.json();
      const updated = await asBrowser(ctx, cookies[role], {
        method: 'PUT',
        url,
        payload: { revision, columns },
      });
      expect(updated.statusCode).toBe(role === 'viewer' ? 403 : 200);
      expect((await as(role, 'GET', url)).json().revision).toBe(
        revision + (role === 'viewer' ? 0 : 1),
      );
    }
    for (const method of ['GET', 'HEAD', 'PUT'] as const) {
      expect((await ctx.app.inject({ method, url })).statusCode).toBe(401);
    }
  });

  it('lets every role read agent avatars and only admins and owners change them', async () => {
    const url = `/api/avatars/agent/${agentId}`;
    const upload = multipartBody(await solidPng(64, 64), 'avatar.png', 'image/png');
    expect((await ctx.request({ method: 'PUT', url, ...upload })).statusCode).toBe(200);
    for (const role of ROLES) {
      expect((await as(role, 'GET', url)).statusCode).toBe(200);
      expect((await asBrowser(ctx, cookies[role], { method: 'HEAD', url })).statusCode).toBe(200);
      const allowed = role === 'owner' || role === 'admin';
      expect(
        (await asBrowser(ctx, cookies[role], { method: 'PUT', url, ...upload })).statusCode,
      ).toBe(allowed ? 200 : 403);
      expect((await as(role, 'DELETE', url)).statusCode).toBe(allowed ? 204 : 403);
      if (allowed) {
        expect((await ctx.request({ method: 'PUT', url, ...upload })).statusCode).toBe(200);
      }
      expect((await as(role, 'GET', url)).statusCode).toBe(200);
    }
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE'] as const) {
      expect((await ctx.app.inject({ method, url })).statusCode).toBe(401);
    }
  });

  it('lets a member wake an agent but not change it', async () => {
    expect((await as('member', 'PATCH', `/api/agents/${agentId}`, { title: 'X' })).statusCode).toBe(
      403,
    );
    expect((await as('member', 'DELETE', `/api/agents/${agentId}`)).statusCode).toBe(403);
    const wake = await as('member', 'POST', `/api/agents/${agentId}/wake`);
    expect(wake.statusCode).not.toBe(403);
    expect((await as('viewer', 'POST', `/api/agents/${agentId}/wake`)).statusCode).toBe(403);
  });

  it('records the acting user as the author of comments and memories', async () => {
    const issue = (
      await as('member', 'POST', '/api/issues', { projectId, title: 'Authored' })
    ).json();
    const comment = await as('member', 'POST', `/api/issues/${issue.key}/comments`, { body: 'hi' });
    expect(comment.statusCode).toBe(201);
    expect(comment.json().author).toEqual({ type: 'user', userId: ids.member });
    const memory = await as('member', 'POST', '/api/memories', {
      scope: 'global',
      title: 'authored memory',
      body: 'b',
    });
    expect(memory.json().author).toEqual({ type: 'user', userId: ids.member });
    const names = (await as('viewer', 'GET', '/api/users/names')).json();
    expect(names.items).toContainEqual({ id: ids.member, name: 'member' });
    const board = await ctx.request({
      method: 'POST',
      url: `/api/issues/${issue.key}/comments`,
      payload: { body: 'from the board token' },
    });
    expect(board.json().author).toEqual({ type: 'board' });
  });

  it('keeps owner powers with owners', async () => {
    const grant = await as('admin', 'PATCH', `/api/users/${ids.viewer}`, { role: 'owner' });
    expect(grant.statusCode).toBe(403);
    expect(grant.json()).toMatchObject({ error: 'owner_required' });
    expect((await as('admin', 'POST', `/api/users/${ids.owner}/ban`)).statusCode).toBe(403);
    expect(
      (await as('admin', 'PATCH', `/api/users/${ids.owner}`, { role: 'viewer' })).statusCode,
    ).toBe(403);
    const create = await as('admin', 'POST', '/api/users', {
      email: 'x@example.com',
      name: 'x',
      role: 'owner',
      password: 'a long enough password',
    });
    expect(create.statusCode).toBe(403);
    const promote = await as('admin', 'PATCH', `/api/users/${ids.viewer}`, { role: 'member' });
    expect(promote.statusCode).toBe(200);
    expect(promote.json()).toMatchObject({ role: 'member' });
    await as('admin', 'PATCH', `/api/users/${ids.viewer}`, { role: 'viewer' });
  });

  it('never removes the last owner and nobody changes their own account', async () => {
    expect(
      (await as('owner', 'PATCH', `/api/users/${ids.owner}`, { role: 'admin' })).statusCode,
    ).toBe(409);
    expect((await as('owner', 'POST', `/api/users/${ids.owner}/ban`)).statusCode).toBe(409);
    expect((await as('admin', 'DELETE', `/api/users/${ids.admin}`)).statusCode).toBe(409);
    const demote = await ctx.request({
      method: 'PATCH',
      url: `/api/users/${ids.owner}`,
      payload: { role: 'admin' },
    });
    expect(demote.statusCode).toBe(409);
    expect(demote.json()).toMatchObject({ error: 'last_owner' });
    const ban = await ctx.request({ method: 'POST', url: `/api/users/${ids.owner}/ban` });
    expect(ban.json()).toMatchObject({ error: 'last_owner' });
    const remove = await ctx.request({ method: 'DELETE', url: `/api/users/${ids.owner}` });
    expect(remove.json()).toMatchObject({ error: 'last_owner' });
  });

  it('transfers ownership: an owner grants it, then the old owner can be demoted', async () => {
    expect(
      (await as('owner', 'PATCH', `/api/users/${ids.admin}`, { role: 'owner' })).statusCode,
    ).toBe(200);
    const audit = await ctx.database.collections.audit.findOne({
      action: 'user.role_changed',
      targetUserId: ids.admin,
    });
    expect(audit).toMatchObject({ details: { from: 'admin', to: 'owner' } });
    const demote = await asBrowser(ctx, cookies.admin, {
      method: 'PATCH',
      url: `/api/users/${ids.owner}`,
      payload: { role: 'admin' },
    });
    expect(demote.statusCode).toBe(200);
    expect(demote.json()).toMatchObject({ role: 'admin' });
  });

  it('creates a user without SMTP by returning a temporary password once', async () => {
    const created = await ctx.request({
      method: 'POST',
      url: '/api/users',
      payload: { email: 'Temp@Example.com', name: 'Temp', role: 'viewer' },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body).toMatchObject({ delivery: 'temporary', user: { email: 'temp@example.com' } });
    expect(
      (await signIn(ctx, 'temp@example.com', body.temporaryPassword)).response.statusCode,
    ).toBe(200);
    const duplicate = await ctx.request({
      method: 'POST',
      url: '/api/users',
      payload: { email: 'temp@example.com', name: 'Temp', role: 'viewer' },
    });
    expect(duplicate.statusCode).toBe(409);
    const reset = await ctx.request({
      method: 'POST',
      url: `/api/users/${body.user.id}/reset-password`,
      payload: { password: 'reset by the admin 1' },
    });
    expect(reset.json()).toEqual({ delivery: 'manual' });
    expect(
      (await signIn(ctx, 'temp@example.com', 'reset by the admin 1')).response.statusCode,
    ).toBe(200);
    const removed = await ctx.request({ method: 'DELETE', url: `/api/users/${body.user.id}` });
    expect(removed.statusCode).toBe(204);
    expect(
      (await signIn(ctx, 'temp@example.com', 'reset by the admin 1')).response.statusCode,
    ).toBe(401);
  });
});
