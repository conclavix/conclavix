import { Collection, ObjectId } from 'mongodb';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAuthSystem, type AuthSystem } from '../src/modules/auth/system.js';
import { SettingsMailer } from '../src/modules/auth/mailer.js';
import { AUTH_SECRET, BOARD_URL, createTestContext, type TestContext } from './helpers.js';
import { PASSWORD, asBrowser, signIn } from './auth-helpers.js';

describe('user administration transactions', () => {
  let ctx: TestContext;
  let system: AuthSystem;
  beforeAll(async () => {
    ctx = await createTestContext({ settingsDefaults: { mfaPolicy: 'optional' } });
    system = await createAuthSystem({
      database: ctx.database,
      secret: AUTH_SECRET,
      boardUrl: BOARD_URL,
      sessionTtlHours: 1,
      rateLimit: false,
      log: ctx.app.log,
      defaults: {
        instanceName: 'Test',
        mfaPolicy: 'optional',
        models: [],
        smtp: { host: null, port: 587, secure: false, user: null, pass: null, from: null },
      },
    });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => ctx.close());
  const input = (email: string) => ({
    email,
    name: 'Test',
    role: 'member' as const,
    password: PASSWORD,
  });
  const setSmtp = (smtp: { host: string; from: string } | null) =>
    ctx.database.inTransaction((session) => system.settings.update({ smtp }, session));
  const failAudit = () => {
    const original = ctx.database.collections.audit.insertOne.bind(ctx.database.collections.audit);
    vi.spyOn(ctx.database.collections.audit, 'insertOne').mockImplementation(async (...args) => {
      await original(...args);
      throw new Error('audit failed after insert');
    });
  };

  it('rolls back user and credentials when their audit cannot commit', async () => {
    failAudit();
    await expect(system.users.create(input('audit@example.com'), 'system')).rejects.toThrow(
      'audit failed',
    );
    expect(await ctx.database.collections.users.countDocuments()).toBe(0);
    expect(await ctx.database.db.collection('account').countDocuments()).toBe(0);
    expect(await ctx.database.collections.audit.countDocuments()).toBe(0);
  });

  it('rolls back failed credential linking and allows a retry', async () => {
    const original = Collection.prototype.updateOne;
    vi.spyOn(Collection.prototype, 'updateOne').mockImplementation(function (
      this: Collection,
      ...args
    ) {
      if (this.collectionName === 'account') return Promise.reject(new Error('link failed'));
      return original.apply(this, args);
    });
    await expect(system.users.create(input('link@example.com'), 'system')).rejects.toThrow(
      'link failed',
    );
    expect(await ctx.database.collections.users.countDocuments({ email: 'link@example.com' })).toBe(
      0,
    );
    vi.restoreAllMocks();
    await expect(system.users.create(input('link@example.com'), 'system')).resolves.toMatchObject({
      delivery: 'manual',
    });
  });

  it('removes the newly created account after mail failure and allows a retry', async () => {
    await setSmtp({ host: 'smtp.test', from: 'test@example.com' });
    const send = vi
      .spyOn(SettingsMailer.prototype, 'send')
      .mockRejectedValueOnce(new Error('mail failed'));
    const invite = { email: 'invite@example.com', name: 'Invite', role: 'member' as const };
    const accountsBefore = await ctx.database.db.collection('account').countDocuments();
    await expect(system.users.create(invite, 'system')).rejects.toThrow('mail failed');
    expect(await ctx.database.collections.users.countDocuments({ email: invite.email })).toBe(0);
    expect(await ctx.database.db.collection('account').countDocuments()).toBe(accountsBefore);
    send.mockResolvedValue(true);
    await expect(system.users.create(invite, 'system')).resolves.toMatchObject({
      delivery: 'email',
    });
    await setSmtp(null);
  });

  it.each(['rejected', 'not sent'] as const)(
    'ends access first and falls back to a temporary password when reset mail is %s',
    async (failure) => {
      const { user } = await system.users.create(
        input(`reset-${failure.replace(' ', '-')}@example.com`),
        'system',
      );
      const userId = new ObjectId(user.id);
      const { cookie } = await signIn(ctx, user.email);
      await system.tokens.create(userId, { name: 'script' });
      await setSmtp({ host: 'smtp.test', from: 'test@example.com' });
      const send = vi.spyOn(SettingsMailer.prototype, 'send');
      if (failure === 'rejected') send.mockRejectedValue(new Error('mail failed'));
      else send.mockResolvedValue(false);
      try {
        const result = await system.users.resetPassword(user.id, undefined, 'system');
        expect(result).toMatchObject({ delivery: 'temporary', reason: 'mail_failed' });
        if (result.delivery !== 'temporary') throw new Error('expected a temporary password');
        expect(await ctx.database.collections.sessions.countDocuments({ userId })).toBe(0);
        expect(await ctx.database.collections.apiTokens.countDocuments({ userId })).toBe(0);
        expect((await asBrowser(ctx, cookie, { method: 'GET', url: '/api/me' })).statusCode).toBe(
          401,
        );
        const actions = (
          await ctx.database.collections.audit.find({ targetUserId: user.id }).toArray()
        ).map((entry) => [entry.action, entry.details]);
        expect(actions).toEqual(
          expect.arrayContaining([
            ['user.password_reset', { delivery: 'email' }],
            ['user.password_reset_mail_failed', { delivery: 'temporary' }],
          ]),
        );
        expect((await signIn(ctx, user.email, PASSWORD)).response.statusCode).toBe(401);
        expect((await signIn(ctx, user.email, result.temporaryPassword)).response.statusCode).toBe(
          200,
        );
      } finally {
        await setSmtp(null);
      }
    },
  );

  it('sends the reset link only after revocation committed and lets it set the password', async () => {
    const { user } = await system.users.create(input('reset-delivered@example.com'), 'system');
    const userId = new ObjectId(user.id);
    const { cookie } = await signIn(ctx, user.email);
    await system.tokens.create(userId, { name: 'script' });
    const accountBefore = await ctx.database.db.collection('account').findOne({ userId });
    await setSmtp({ host: 'smtp.test', from: 'test@example.com' });
    let resetUrl: URL | undefined;
    vi.spyOn(SettingsMailer.prototype, 'send').mockImplementation(async (mail) => {
      expect(await ctx.database.collections.sessions.countDocuments({ userId })).toBe(0);
      expect(await ctx.database.collections.apiTokens.countDocuments({ userId })).toBe(0);
      expect(
        await ctx.database.collections.audit.countDocuments({
          targetUserId: user.id,
          action: 'user.password_reset',
        }),
      ).toBe(1);
      resetUrl = new URL(mail.text.split('\n').find((line) => line.startsWith('http')) ?? '');
      return true;
    });
    try {
      await expect(system.users.resetPassword(user.id, undefined, 'system')).resolves.toEqual({
        delivery: 'email',
      });
      expect(await ctx.database.db.collection('account').findOne({ userId })).toEqual(
        accountBefore,
      );
      expect((await asBrowser(ctx, cookie, { method: 'GET', url: '/api/me' })).statusCode).toBe(
        401,
      );
      if (!resetUrl) throw new Error('Reset email did not contain a link');
      const redirect = await asBrowser(ctx, '', {
        method: 'GET',
        url: resetUrl.pathname + resetUrl.search,
      });
      expect(redirect.statusCode).toBe(302);
      const token = new URL(String(redirect.headers.location)).searchParams.get('token');
      const reset = await asBrowser(ctx, '', {
        method: 'POST',
        url: '/api/auth/reset-password',
        payload: { token, newPassword: 'chosen through reset link 123' },
      });
      expect(reset.statusCode).toBe(200);
      expect(
        (await signIn(ctx, user.email, 'chosen through reset link 123')).response.statusCode,
      ).toBe(200);
      expect((await signIn(ctx, user.email, PASSWORD)).response.statusCode).toBe(401);
    } finally {
      await setSmtp(null);
    }
  });

  it.each(['ban', 'password'] as const)('%s revokes sessions and API tokens', async (operation) => {
    const { user } = await system.users.create(input(`revoke-${operation}@example.com`), 'system');
    const userId = new ObjectId(user.id);
    await signIn(ctx, user.email);
    const { token } = await system.tokens.create(userId, { name: 'script' });
    expect(await system.tokens.authenticate(token)).toEqual(userId);
    if (operation === 'ban') await system.users.setBanned(user.id, true, 'system');
    else await system.users.resetPassword(user.id, 'another password 123', 'system');
    expect(await ctx.database.collections.sessions.countDocuments({ userId })).toBe(0);
    expect(await ctx.database.collections.apiTokens.countDocuments({ userId })).toBe(0);
    expect(await system.tokens.authenticate(token)).toBeNull();
  });

  it.each(['ban', 'remove', 'mfa', 'password', 'role'] as const)(
    'rolls back %s and its audit together',
    async (operation) => {
      const email = `${operation}@example.com`;
      const { user } = await system.users.create(input(email), 'system');
      const userId = new ObjectId(user.id);
      await ctx.database.collections.users.updateOne(
        { _id: userId },
        { $set: { twoFactorEnabled: true } },
      );
      await ctx.database.db.collection('twoFactor').insertOne({ userId, secret: 'synthetic' });
      await ctx.database.collections.sessions.insertOne({
        _id: new ObjectId(),
        userId,
        token: operation,
        expiresAt: new Date(Date.now() + 60000),
      });
      await system.tokens.create(userId, { name: operation });
      const before = await ctx.database.collections.users.findOne({ _id: userId });
      const accountBefore = await ctx.database.db.collection('account').findOne({ userId });
      const auditsBefore = await ctx.database.collections.audit.countDocuments({
        targetUserId: user.id,
      });
      failAudit();
      const work = {
        ban: () => system.users.setBanned(user.id, true, 'system'),
        remove: () => system.users.remove(user.id, 'system'),
        mfa: () => system.users.resetMfa(user.id, 'system'),
        password: () => system.users.resetPassword(user.id, 'new password 12345', 'system'),
        role: () => system.users.update(user.id, { role: 'viewer' }, 'system'),
      };
      await expect(work[operation]()).rejects.toThrow('audit failed');
      expect(await ctx.database.collections.users.findOne({ _id: userId })).toEqual(before);
      expect(await ctx.database.db.collection('account').findOne({ userId })).toEqual(
        accountBefore,
      );
      expect(await ctx.database.collections.sessions.countDocuments({ userId })).toBe(1);
      expect(await ctx.database.collections.apiTokens.countDocuments({ userId })).toBe(1);
      expect(await ctx.database.db.collection('twoFactor').countDocuments({ userId })).toBe(1);
      expect(await ctx.database.collections.audit.countDocuments({ targetUserId: user.id })).toBe(
        auditsBefore,
      );
    },
  );

  it('creates a missing credential account atomically on password reset', async () => {
    const { user } = await system.users.create(input('missing@example.com'), 'system');
    const userId = new ObjectId(user.id);
    await ctx.database.db.collection('account').deleteMany({ userId });
    await system.users.resetPassword(user.id, 'replacement password 123', 'system');
    expect((await signIn(ctx, user.email, 'replacement password 123')).response.statusCode).toBe(
      200,
    );
  });
});
