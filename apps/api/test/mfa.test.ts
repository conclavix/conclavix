import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';
import { PASSWORD, asBrowser, cookiesOf, createUser, signIn, totp } from './auth-helpers.js';

const TOTP_PERIOD_MS = 30_000;

describe('two-factor authentication and the MFA policy', () => {
  let ctx: TestContext;
  let adminId: string;
  let adminCookie: string;
  let totpUri: string;
  let backupCodes: string[];

  const enrol = async (cookie: string) => {
    const enabled = await asBrowser(ctx, cookie, {
      method: 'POST',
      url: '/api/auth/two-factor/enable',
      payload: { password: PASSWORD },
    });
    expect(enabled.statusCode).toBe(200);
    const body = enabled.json() as { totpURI: string; backupCodes: string[] };
    const verified = await asBrowser(ctx, cookie, {
      method: 'POST',
      url: '/api/auth/two-factor/verify-totp',
      payload: { code: totp(body.totpURI) },
    });
    expect(verified.statusCode).toBe(200);
    return { ...body, cookie: cookiesOf(verified, cookie) };
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    adminId = await createUser(ctx, 'admin@example.com', 'admin');
    await createUser(ctx, 'member@example.com', 'member');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('blocks an admin without 2FA on every route except enrolment and the own profile', async () => {
    const { response, cookie } = await signIn(ctx, 'admin@example.com');
    expect(response.statusCode).toBe(200);
    const projects = await asBrowser(ctx, cookie, { method: 'GET', url: '/api/projects' });
    expect(projects.statusCode).toBe(403);
    expect(projects.json()).toMatchObject({ error: 'mfa_enrollment_required' });
    const sessions = await asBrowser(ctx, cookie, {
      method: 'GET',
      url: '/api/auth/list-sessions',
    });
    expect(sessions.statusCode).toBe(403);
    const me = await asBrowser(ctx, cookie, { method: 'GET', url: '/api/me' });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ mfaRequired: true, twoFactorEnabled: false });
    const session = await asBrowser(ctx, cookie, { method: 'GET', url: '/api/auth/get-session' });
    expect(session.statusCode).toBe(200);
    adminCookie = cookie;
  });

  it('enrols TOTP with recovery codes and then lets the admin in', async () => {
    const result = await enrol(adminCookie);
    totpUri = result.totpURI;
    backupCodes = result.backupCodes;
    adminCookie = result.cookie;
    expect(backupCodes.length).toBe(10);
    const projects = await asBrowser(ctx, adminCookie, { method: 'GET', url: '/api/projects' });
    expect(projects.statusCode).toBe(200);
  });

  it('asks for the second factor at sign-in and accepts a TOTP code', async () => {
    const { response, cookie } = await signIn(ctx, 'admin@example.com');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ twoFactorRedirect: true });
    const blocked = await asBrowser(ctx, cookie, { method: 'GET', url: '/api/me' });
    expect(blocked.statusCode).toBe(401);
    const wrong = await asBrowser(ctx, cookie, {
      method: 'POST',
      url: '/api/auth/two-factor/verify-totp',
      payload: { code: '000000' === totp(totpUri) ? '111111' : '000000' },
    });
    expect(wrong.statusCode).toBe(401);
    const verified = await asBrowser(ctx, cookie, {
      method: 'POST',
      url: '/api/auth/two-factor/verify-totp',
      payload: { code: totp(totpUri, Date.now() + TOTP_PERIOD_MS) },
    });
    expect(verified.statusCode).toBe(200);
    const session = cookiesOf(verified, cookie);
    expect((await asBrowser(ctx, session, { method: 'GET', url: '/api/me' })).statusCode).toBe(200);
    expect(
      await ctx.database.collections.audit.countDocuments({ action: 'auth.mfa_failed' }),
    ).toBeGreaterThan(0);
  });

  it('accepts a recovery code once', async () => {
    const code = backupCodes[0] ?? '';
    const first = await signIn(ctx, 'admin@example.com');
    const used = await asBrowser(ctx, first.cookie, {
      method: 'POST',
      url: '/api/auth/two-factor/verify-backup-code',
      payload: { code },
    });
    expect(used.statusCode).toBe(200);
    const session = cookiesOf(used, first.cookie);
    expect(
      (await asBrowser(ctx, session, { method: 'GET', url: '/api/projects' })).statusCode,
    ).toBe(200);
    const second = await signIn(ctx, 'admin@example.com');
    const reused = await asBrowser(ctx, second.cookie, {
      method: 'POST',
      url: '/api/auth/two-factor/verify-backup-code',
      payload: { code },
    });
    expect(reused.statusCode).toBe(401);
  });

  it('blocks an existing member session once the policy requires MFA for everyone', async () => {
    const { cookie } = await signIn(ctx, 'member@example.com');
    expect((await asBrowser(ctx, cookie, { method: 'GET', url: '/api/projects' })).statusCode).toBe(
      200,
    );
    const policy = await ctx.request({
      method: 'PATCH',
      url: '/api/settings',
      payload: { mfaPolicy: 'required' },
    });
    expect(policy.statusCode).toBe(200);
    const blocked = await asBrowser(ctx, cookie, { method: 'GET', url: '/api/projects' });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ error: 'mfa_enrollment_required' });
    await ctx.request({ method: 'PATCH', url: '/api/settings', payload: { mfaPolicy: null } });
  });

  it('refuses to turn 2FA off while the policy requires it for the role', async () => {
    const disable = (cookie: string) =>
      asBrowser(ctx, cookie, {
        method: 'POST',
        url: '/api/auth/two-factor/disable',
        payload: { password: PASSWORD },
      });
    const refused = await disable(adminCookie);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: 'mfa_required_by_policy' });
    const admin = await asBrowser(ctx, adminCookie, { method: 'GET', url: '/api/me' });
    expect(admin.json()).toMatchObject({ twoFactorEnabled: true });

    await createUser(ctx, 'optional@example.com', 'member');
    const member = await enrol((await signIn(ctx, 'optional@example.com')).cookie);
    const allowed = await disable(member.cookie);
    expect(allowed.statusCode).toBe(200);
    const after = await asBrowser(ctx, cookiesOf(allowed, member.cookie), {
      method: 'GET',
      url: '/api/me',
    });
    expect(after.json()).toMatchObject({ twoFactorEnabled: false, mfaRequired: false });
  });

  it('lets an owner reset the 2FA of another user and audits it', async () => {
    const reset = await ctx.request({ method: 'POST', url: `/api/users/${adminId}/reset-2fa` });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ twoFactorEnabled: false });
    expect(await ctx.database.db.collection('twoFactor').countDocuments()).toBe(0);
    const { response } = await signIn(ctx, 'admin@example.com');
    expect(response.json()).not.toHaveProperty('twoFactorRedirect');
    expect(
      await ctx.database.collections.audit.findOne({
        action: 'user.mfa_reset',
        targetUserId: adminId,
      }),
    ).toMatchObject({ actor: { type: 'board' } });
  });
});
