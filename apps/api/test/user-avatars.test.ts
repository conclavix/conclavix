import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';
import { asBrowser, createUser, signIn } from './auth-helpers.js';
import { multipartBody, solidPng } from './fixtures/images.js';

type Role = 'owner' | 'admin' | 'member' | 'viewer';

describe('user avatars', () => {
  let ctx: TestContext;
  const ids = {} as Record<Role | 'other', string>;
  const cookies = {} as Record<Role | 'other', string>;
  let png: Buffer;

  const put = (who: Role | 'other', id: string) =>
    asBrowser(ctx, cookies[who], {
      method: 'PUT',
      url: `/api/avatars/user/${id}`,
      ...multipartBody(png, 'me.png', 'image/png'),
    });
  const remove = (who: Role | 'other', id: string) =>
    asBrowser(ctx, cookies[who], { method: 'DELETE', url: `/api/avatars/user/${id}` });
  const me = async (who: Role | 'other') =>
    (await asBrowser(ctx, cookies[who], { method: 'GET', url: '/api/me' })).json();

  beforeAll(async () => {
    ctx = await createTestContext({ settingsDefaults: { mfaPolicy: 'optional' } });
    png = await solidPng(64, 64);
    for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
      ids[role] = await createUser(ctx, `${role}@example.com`, role);
      cookies[role] = (await signIn(ctx, `${role}@example.com`)).cookie;
    }
    ids.other = await createUser(ctx, 'other@example.com', 'member');
    cookies.other = (await signIn(ctx, 'other@example.com')).cookie;
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('lets every user set and remove their own avatar and shows it on the profile', async () => {
    for (const role of ['member', 'viewer'] as const) {
      const response = await put(role, ids[role]);
      expect(response.statusCode, role).toBe(200);
      const { url, etag } = response.json();
      expect(url).toBe(`/api/avatars/user/${ids[role]}?v=${etag}`);
      expect((await me(role)).avatarUrl).toBe(url);
      const image = await asBrowser(ctx, cookies.other, { method: 'GET', url });
      expect(image.statusCode).toBe(200);
      expect(image.headers['content-type']).toBe('image/webp');
      expect((await remove(role, ids[role])).statusCode).toBe(204);
      expect((await me(role)).avatarUrl).toBeNull();
    }
  });

  it('forbids a member from changing another user avatar', async () => {
    expect((await put('member', ids.other)).statusCode).toBe(403);
    expect((await remove('member', ids.other)).statusCode).toBe(403);
    expect((await put('viewer', ids.member)).statusCode).toBe(403);
    expect((await me('other')).avatarUrl).toBeNull();
  });

  it('lets admins, owners and the board token change any user avatar', async () => {
    const admin = await put('admin', ids.other);
    expect(admin.statusCode).toBe(200);
    const listed = await ctx.request({ method: 'GET', url: `/api/users/${ids.other}` });
    expect(listed.json().avatarUrl).toBe(admin.json().url);
    expect((await remove('owner', ids.other)).statusCode).toBe(204);
    const board = await ctx.request({
      method: 'PUT',
      url: `/api/avatars/user/${ids.other}`,
      ...multipartBody(png, 'me.png', 'image/png'),
    });
    expect(board.statusCode).toBe(200);
    expect((await me('other')).avatarUrl).toBe(board.json().url);
  });

  it('keeps owner avatars with owners: an admin may not change them', async () => {
    const response = await put('admin', ids.owner);
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('owner_required');
    expect((await remove('admin', ids.owner)).statusCode).toBe(403);
    expect((await put('owner', ids.admin)).statusCode).toBe(200);
    expect((await put('owner', ids.owner)).statusCode).toBe(200);
  });

  it('answers 404 for unknown or malformed users', async () => {
    const missing = new ObjectId().toHexString();
    expect((await put('admin', missing)).statusCode).toBe(404);
    expect((await put('member', 'not-an-id')).statusCode).toBe(404);
    const get = await asBrowser(ctx, cookies.member, {
      method: 'GET',
      url: `/api/avatars/user/${missing}`,
    });
    expect(get.statusCode).toBe(404);
  });

  it('removes the avatar together with the user', async () => {
    const id = await createUser(ctx, 'leaving@example.com', 'member');
    const saved = await ctx.request({
      method: 'PUT',
      url: `/api/avatars/user/${id}`,
      ...multipartBody(png, 'me.png', 'image/png'),
    });
    expect(saved.statusCode).toBe(200);
    expect((await ctx.request({ method: 'DELETE', url: `/api/users/${id}` })).statusCode).toBe(204);
    expect(
      await ctx.database.collections.avatars.countDocuments({
        'owner.type': 'user',
        'owner.id': id,
      }),
    ).toBe(0);
  });
});
