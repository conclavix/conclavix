import type { FastifyBaseLogger } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Collections } from '../src/db.js';
import { SecretBox } from '../src/modules/settings/secret-box.js';
import { SettingsService, type SettingsDefaults } from '../src/modules/settings/service.js';
import { AUTH_SECRET, createTestContext, type TestContext } from './helpers.js';
import { asBrowser, createUser, signIn } from './auth-helpers.js';

const ENV: SettingsDefaults = {
  instanceName: 'From Env',
  mfaPolicy: 'optional',
  models: ['opus', 'sonnet'],
  smtp: {
    host: 'smtp.env',
    port: 587,
    secure: false,
    user: 'env',
    pass: 'env-pass',
    from: 'a@b.c',
  },
};

describe('instance settings', () => {
  let ctx: TestContext;
  let adminCookie: string;

  const patch = (payload: object) =>
    ctx.request({ method: 'PATCH', url: '/api/settings', payload });

  beforeAll(async () => {
    ctx = await createTestContext({ settingsDefaults: ENV });
    await createUser(ctx, 'admin@example.com', 'admin');
    adminCookie = (await signIn(ctx, 'admin@example.com')).cookie;
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('falls back to ENV values and never shows the SMTP password', async () => {
    const response = await ctx.request({ method: 'GET', url: '/api/settings' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.values).toMatchObject({
      instanceName: 'From Env',
      models: ['opus', 'sonnet'],
      smtp: { host: 'smtp.env', passSet: true },
    });
    expect(body.sources).toEqual({
      instanceName: 'env',
      mfaPolicy: 'env',
      models: 'env',
      smtp: 'env',
    });
    expect(body.ownerOnly).toEqual(['mfaPolicy', 'smtp']);
    expect(response.body).not.toContain('env-pass');
    expect((await ctx.request({ method: 'GET', url: '/api/models' })).json()).toEqual({
      items: ['opus', 'sonnet'],
    });
  });

  it('stores overrides, resets them with null and audits only the changed groups', async () => {
    const stored = await patch({ instanceName: 'From DB', models: ['opus-4'] });
    expect(stored.json().values).toMatchObject({ instanceName: 'From DB', models: ['opus-4'] });
    expect(stored.json().sources).toMatchObject({ instanceName: 'db', models: 'db' });
    expect((await ctx.request({ method: 'GET', url: '/api/models' })).json().items).toEqual([
      'opus-4',
    ]);
    const reset = await patch({ instanceName: null });
    expect(reset.json().values.instanceName).toBe('From Env');
    expect(reset.json().sources.instanceName).toBe('env');
    const entry = await ctx.database.collections.audit.findOne(
      { action: 'settings.changed' },
      { sort: { _id: 1 } },
    );
    expect(entry?.details).toEqual({ groups: ['instanceName', 'models'] });
    expect(JSON.stringify(entry)).not.toContain('From DB');
  });

  it('treats the SMTP password as write-only and encrypts it at rest', async () => {
    const set = await patch({ smtp: { host: 'smtp.db', pass: 'db-secret-pass' } });
    expect(set.statusCode).toBe(200);
    expect(set.body).not.toContain('db-secret-pass');
    expect(set.json().values.smtp).toMatchObject({ host: 'smtp.db', user: 'env', passSet: true });
    const raw = await ctx.database.collections.settings.findOne({});
    expect(JSON.stringify(raw)).not.toContain('db-secret-pass');
    expect(raw?.smtp?.passEncrypted).toBeTruthy();

    const keep = await patch({ smtp: { port: 2525, pass: '' } });
    expect(keep.json().values.smtp).toMatchObject({ port: 2525, passSet: true });
    expect((await ctx.database.collections.settings.findOne({}))?.smtp?.passEncrypted).toBe(
      raw?.smtp?.passEncrypted,
    );
    const cleared = await patch({ smtp: { pass: null } });
    expect(cleared.json().values.smtp).toMatchObject({ host: 'smtp.db', passSet: false });
    expect((await ctx.database.collections.settings.findOne({}))?.smtp?.passEncrypted).toBe('');
    const back = await patch({ smtp: null });
    expect(back.json().values.smtp).toMatchObject({ host: 'smtp.env', port: 587 });
    expect(back.json().sources.smtp).toBe('env');
    expect(back.json().values.smtp.passSet).toBe(true);
  });

  it('lets an admin change settings but only an owner the MFA policy and SMTP', async () => {
    const name = await asBrowser(ctx, adminCookie, {
      method: 'PATCH',
      url: '/api/settings',
      payload: { instanceName: 'Admin Named' },
    });
    expect(name.statusCode).toBe(200);
    const policy = await asBrowser(ctx, adminCookie, {
      method: 'PATCH',
      url: '/api/settings',
      payload: { mfaPolicy: 'required' },
    });
    expect(policy.statusCode).toBe(403);
    expect(policy.json()).toMatchObject({
      error: 'owner_required',
      details: { fields: ['mfaPolicy'] },
    });
    expect((await patch({ mfaPolicy: 'sometimes' })).statusCode).toBe(400);
    // Whoever controls SMTP receives every password-reset link, including the owners'.
    for (const smtp of [{ host: 'smtp.attacker.test' }, null]) {
      const mail = await asBrowser(ctx, adminCookie, {
        method: 'PATCH',
        url: '/api/settings',
        payload: { smtp },
      });
      expect(mail.statusCode).toBe(403);
      expect(mail.json()).toMatchObject({ error: 'owner_required', details: { fields: ['smtp'] } });
    }
    expect((await ctx.database.collections.settings.findOne({}))?.smtp?.host).not.toBe(
      'smtp.attacker.test',
    );
  });

  it('commits a settings change only together with its audit entry', async () => {
    const audit = ctx.database.collections.audit;
    const insertOne = audit.insertOne.bind(audit);
    const spy = vi.spyOn(audit, 'insertOne').mockImplementation(async (...args) => {
      await insertOne(...args);
      throw new Error('audit failed after insert');
    });
    try {
      const before = await ctx.database.collections.settings.findOne({});
      const audits = await audit.countDocuments();
      const failed = await patch({ instanceName: 'Never Stored' });
      expect(failed.statusCode).toBe(500);
      expect(await ctx.database.collections.settings.findOne({})).toEqual(before);
      expect(await audit.countDocuments()).toBe(audits);
      spy.mockRestore();
      const view = await ctx.request({ method: 'GET', url: '/api/settings' });
      expect(view.json().values.instanceName).not.toBe('Never Stored');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('settings cache', () => {
  const log = { warn: () => undefined, error: () => undefined } as unknown as FastifyBaseLogger;

  it('serves the last known good values when the database fails', async () => {
    let fail = false;
    const collections = {
      settings: {
        findOne: async () => {
          if (fail) throw new Error('down');
          return { _id: 'instance', mfaPolicy: 'required', updatedAt: new Date() };
        },
      },
    } as unknown as Collections;
    const service = new SettingsService(collections, ENV, new SecretBox(AUTH_SECRET), log, 0);
    expect((await service.current()).mfaPolicy).toBe('required');
    fail = true;
    expect((await service.current()).mfaPolicy).toBe('required');
  });

  it.each(['env-pass', null])(
    'uses ENV password %s when stored SMTP cannot decrypt',
    async (pass) => {
      const box = new SecretBox(AUTH_SECRET);
      const encrypted = new SecretBox('a different secret').seal('stored-secret');
      const collections = {
        settings: {
          findOne: async () => ({ mfaPolicy: 'required', smtp: { passEncrypted: encrypted } }),
        },
      } as unknown as Collections;
      const error = vi.fn();
      const service = new SettingsService(
        collections,
        { ...ENV, smtp: { ...ENV.smtp, pass } },
        box,
        { ...log, error },
      );
      const current = await service.current();
      expect(current.mfaPolicy).toBe('required');
      expect(current.smtp.pass).toBe(pass);
      expect(error).toHaveBeenCalledWith(
        { err: expect.any(Error) },
        expect.stringContaining('SMTP password'),
      );
      expect(JSON.stringify(error.mock.calls)).not.toContain(encrypted);
    },
  );

  it('fails closed instead of assuming the ENV policy when nothing is cached', async () => {
    const collections = {
      settings: {
        findOne: async () => {
          throw new Error('down');
        },
      },
    } as unknown as Collections;
    const service = new SettingsService(collections, ENV, new SecretBox(AUTH_SECRET), log, 0);
    await expect(service.current()).rejects.toMatchObject({ statusCode: 503 });
  });
});
