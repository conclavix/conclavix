import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';
import { asBrowser, createUser, signIn } from './auth-helpers.js';
import {
  FREE_KEY,
  LIMITED_KEY,
  PRO_KEY,
  RESET_AT,
  startFakeDirectory,
  type FakeDirectory,
} from './fixtures/fake-skill-directory.js';

const SECRET = 'sd_live_super-secret-key-value-123';

describe('skill directory sources', () => {
  let ctx: TestContext;
  let logs = '';
  let adminCookie: string;
  let memberCookie: string;
  let viewerCookie: string;

  beforeAll(async () => {
    const stream = new Writable({
      write(chunk, _encoding, done) {
        logs += String(chunk);
        done();
      },
    });
    ctx = await createTestContext({
      settingsDefaults: { mfaPolicy: 'optional' },
      logger: { level: 'trace', stream },
    });
    await createUser(ctx, 'admin@example.com', 'admin');
    await createUser(ctx, 'member@example.com', 'member');
    await createUser(ctx, 'viewer@example.com', 'viewer');
    adminCookie = (await signIn(ctx, 'admin@example.com')).cookie;
    memberCookie = (await signIn(ctx, 'member@example.com')).cookie;
    viewerCookie = (await signIn(ctx, 'viewer@example.com')).cookie;
  });

  afterAll(async () => {
    await ctx.close();
  });

  const create = (payload: object, cookie = adminCookie) =>
    asBrowser(ctx, cookie, { method: 'POST', url: '/api/skill-sources', payload });

  it('creates, lists, updates and deletes a source with a write-only, encrypted key', async () => {
    const created = await create({
      name: 'Skills Directory',
      provider: 'skillsdirectory',
      apiKey: SECRET,
    });
    expect(created.statusCode).toBe(201);
    const source = created.json();
    expect(source).toMatchObject({
      name: 'Skills Directory',
      provider: 'skillsdirectory',
      baseUrl: 'https://www.skillsdirectory.com/api/v1',
      baseUrlIsDefault: true,
      enabled: true,
      hasApiKey: true,
    });
    expect(created.body).not.toContain(SECRET);

    const raw = await ctx.database.collections.skillSources.findOne({});
    expect(JSON.stringify(raw)).not.toContain(SECRET);
    expect(raw?.apiKeyEncrypted).toBeTruthy();

    const list = await asBrowser(ctx, adminCookie, { method: 'GET', url: '/api/skill-sources' });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().providers[0]).toMatchObject({ id: 'skillsdirectory' });
    expect(list.body).not.toContain(SECRET);

    const keep = await asBrowser(ctx, adminCookie, {
      method: 'PATCH',
      url: `/api/skill-sources/${source.id}`,
      payload: { name: 'Directory', apiKey: '', enabled: false },
    });
    expect(keep.statusCode).toBe(200);
    expect(keep.json()).toMatchObject({ name: 'Directory', enabled: false, hasApiKey: true });
    expect((await ctx.database.collections.skillSources.findOne({}))?.apiKeyEncrypted).toBe(
      raw?.apiKeyEncrypted,
    );

    const cleared = await asBrowser(ctx, adminCookie, {
      method: 'PATCH',
      url: `/api/skill-sources/${source.id}`,
      payload: { apiKey: null },
    });
    expect(cleared.json().hasApiKey).toBe(false);

    const duplicate = await create({ name: 'directory', provider: 'skillsdirectory' });
    expect(duplicate.statusCode).toBe(409);

    const removed = await asBrowser(ctx, adminCookie, {
      method: 'DELETE',
      url: `/api/skill-sources/${source.id}`,
    });
    expect(removed.statusCode).toBe(204);
    expect(await ctx.database.collections.skillSources.countDocuments()).toBe(0);

    const audits = await ctx.database.collections.audit
      .find({ action: { $regex: /^skill_source\./ } })
      .sort({ _id: 1 })
      .toArray();
    expect(audits.map((entry) => entry.action)).toEqual([
      'skill_source.created',
      'skill_source.updated',
      'skill_source.updated',
      'skill_source.deleted',
    ]);
    expect(audits[0]?.details).toMatchObject({ apiKey: 'set', provider: 'skillsdirectory' });
    expect(audits[1]?.details).toMatchObject({ changes: { name: true, enabled: false } });
    expect(audits[1]?.details['changes']).not.toHaveProperty('apiKey');
    expect(audits[2]?.details).toMatchObject({ changes: { apiKey: 'removed' } });
    expect(JSON.stringify(audits)).not.toContain(SECRET);
    expect(logs).not.toContain(SECRET);
  });

  it('validates input and rejects unknown providers', async () => {
    expect((await create({ name: '', provider: 'skillsdirectory' })).statusCode).toBe(400);
    expect((await create({ name: 'x', provider: 'other' })).statusCode).toBe(400);
    expect(
      (await create({ name: 'x', provider: 'skillsdirectory', apiKey: 'has space' })).statusCode,
    ).toBe(400);
    expect((await create({ name: 'x', provider: 'skillsdirectory', extra: true })).statusCode).toBe(
      400,
    );
  });

  it('refuses private, loopback and plain-http directory URLs', async () => {
    for (const baseUrl of [
      'http://www.skillsdirectory.com/api/v1',
      'https://127.0.0.1/api/v1',
      'https://10.0.0.1/api/v1',
      'https://localhost/api/v1',
      'https://[::1]/api/v1',
      'https://169.254.169.254/latest',
    ]) {
      const response = await create({
        name: `ssrf ${baseUrl}`,
        provider: 'skillsdirectory',
        baseUrl,
      });
      expect(response.statusCode, baseUrl).toBe(422);
    }
    expect(await ctx.database.collections.skillSources.countDocuments()).toBe(0);
  });

  it('lets only admins manage, browse and import', async () => {
    const created = await create({ name: 'Perms', provider: 'skillsdirectory' });
    const id = created.json().id as string;
    for (const cookie of [memberCookie, viewerCookie]) {
      expect((await create({ name: 'Nope', provider: 'skillsdirectory' }, cookie)).statusCode).toBe(
        403,
      );
      for (const [method, url] of [
        ['GET', '/api/skill-sources'],
        ['PATCH', `/api/skill-sources/${id}`],
        ['DELETE', `/api/skill-sources/${id}`],
        ['POST', `/api/skill-sources/${id}/test`],
        ['GET', `/api/skill-sources/${id}/skills`],
        ['GET', `/api/skill-sources/${id}/categories`],
        ['GET', `/api/skill-sources/${id}/skills/pdf-tools`],
        ['POST', `/api/skill-sources/${id}/import`],
      ] as const) {
        const response = await asBrowser(ctx, cookie, {
          method,
          url,
          ...(method === 'GET' || method === 'DELETE' ? {} : { payload: { name: 'x' } }),
        });
        expect(response.statusCode, `${method} ${url}`).toBe(403);
      }
    }
    await asBrowser(ctx, adminCookie, { method: 'DELETE', url: `/api/skill-sources/${id}` });
  });
});

describe('skill directory browsing and import', () => {
  let ctx: TestContext;
  let fake: FakeDirectory;
  let adminCookie: string;
  let logs = '';

  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    asBrowser(ctx, adminCookie, { method, url, ...(payload ? { payload } : {}) });

  const source = async (name: string, apiKey: string): Promise<string> => {
    const response = await call('POST', '/api/skill-sources', {
      name,
      provider: 'skillsdirectory',
      baseUrl: fake.baseUrl,
      apiKey,
    });
    expect(response.statusCode).toBe(201);
    return response.json().id as string;
  };

  beforeAll(async () => {
    fake = await startFakeDirectory();
    const stream = new Writable({
      write(chunk, _encoding, done) {
        logs += String(chunk);
        done();
      },
    });
    ctx = await createTestContext({
      settingsDefaults: { mfaPolicy: 'optional' },
      skillSourcesAllowPrivate: true,
      logger: { level: 'trace', stream },
    });
    await createUser(ctx, 'admin@example.com', 'admin');
    adminCookie = (await signIn(ctx, 'admin@example.com')).cookie;
  });

  afterAll(async () => {
    await ctx.close();
    await fake.close();
  });

  it('tests the connection and reports tier and remaining requests', async () => {
    const id = await source('Free', FREE_KEY);
    const response = await call('POST', `/api/skill-sources/${id}/test`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      tier: 'free',
      keyStatus: 'active',
      quota: { remaining: 90, limit: 100, resetAt: RESET_AT },
    });
    expect(response.body).not.toContain('sd_live_ab');
    expect(fake.requests.at(-1)).toMatchObject({ key: FREE_KEY });
    expect(fake.requests.at(-1)?.userAgent).toMatch(/^Conclavix\//);

    const bad = await source('Bad key', 'wrong-key-123');
    const failed = await call('POST', `/api/skill-sources/${bad}/test`);
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error).toBe('directory_auth_failed');
    expect(logs).not.toContain(FREE_KEY);
    expect(logs).not.toContain('wrong-key-123');
  });

  it('searches with caching and shows content as unavailable on the free tier', async () => {
    const id = await source('Free browse', FREE_KEY);
    const before = fake.requests.length;
    const search = await call(
      'GET',
      `/api/skill-sources/${id}/skills?q=pdf&sort=stars&page=1&limit=10`,
    );
    expect(search.statusCode).toBe(200);
    const body = search.json();
    expect(body).toMatchObject({
      total: 1,
      page: 1,
      cached: false,
      quota: { remaining: 90, tier: 'free' },
    });
    expect(body.items[0]).toMatchObject({
      slug: 'pdf-tools',
      verified: true,
      securityGrade: null,
      importedSkillId: null,
      webUrl: `${fake.url}/skills/pdf-tools`,
    });
    const again = await call(
      'GET',
      `/api/skill-sources/${id}/skills?q=pdf&sort=stars&page=1&limit=10`,
    );
    expect(again.json().cached).toBe(true);
    expect(fake.requests.length).toBe(before + 1);

    const categories = await call('GET', `/api/skill-sources/${id}/categories`);
    expect(categories.json().items.map((c: { slug: string }) => c.slug)).toEqual([
      'documents',
      'writing',
    ]);

    const detail = await call('GET', `/api/skill-sources/${id}/skills/pdf-tools`);
    expect(detail.json().content).toEqual({
      available: false,
      reason: 'tier',
      message: 'This directory only provides skill content on a paid plan',
    });
    const imported = await call('POST', `/api/skill-sources/${id}/import`, {
      slug: 'pdf-tools',
      confirmUntrusted: true,
    });
    expect(imported.statusCode).toBe(422);
    expect(imported.json()).toMatchObject({
      error: 'content_unavailable',
      details: { reason: 'tier', url: `${fake.url}/skills/pdf-tools` },
    });
    expect(await ctx.database.collections.skills.countDocuments()).toBe(0);
    expect((await call('GET', `/api/skill-sources/${id}/skills/missing-skill`)).statusCode).toBe(
      404,
    );
    expect((await call('GET', `/api/skill-sources/${id}/skills?sort=bogus`)).statusCode).toBe(400);
  });

  it('imports content with provenance, detects duplicates and replaces on request', async () => {
    const id = await source('Pro', PRO_KEY);
    const unconfirmed = await call('POST', `/api/skill-sources/${id}/import`, {
      slug: 'pdf-tools',
    });
    expect(unconfirmed.statusCode).toBe(400);

    const created = await call('POST', `/api/skill-sources/${id}/import`, {
      slug: 'pdf-tools',
      confirmUntrusted: true,
    });
    expect(created.statusCode).toBe(201);
    const skill = created.json().skill;
    expect(skill).toMatchObject({
      name: 'pdf-tools',
      description: 'Extract text and tables from PDF files',
      body: '# PDF tools\n\nUse pdftotext to extract text.\n',
      files: [],
      source: {
        sourceId: id,
        provider: 'skillsdirectory',
        externalId: 'sk_1',
        slug: 'pdf-tools',
        url: `${fake.url}/skills/pdf-tools`,
      },
    });
    expect(skill.source.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const read = await call('GET', `/api/skills/${skill.id}`);
    expect(read.json().source).toMatchObject({ externalId: 'sk_1' });
    const list = await call('GET', '/api/skills');
    expect(list.json().items[0]).toMatchObject({
      name: 'pdf-tools',
      sourceProvider: 'skillsdirectory',
    });
    const agents = await ctx.database.collections.agents.countDocuments({
      skillIds: { $exists: true, $ne: [] },
    });
    expect(agents).toBe(0);

    const search = await call('GET', `/api/skill-sources/${id}/skills`);
    expect(
      search.json().items.find((item: { slug: string }) => item.slug === 'pdf-tools')
        .importedSkillId,
    ).toBe(skill.id);
    expect(search.json().items[0].securityGrade).toBe('A');

    const duplicate = await call('POST', `/api/skill-sources/${id}/import`, {
      slug: 'pdf-tools',
      confirmUntrusted: true,
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({
      error: 'already_imported',
      details: { skillId: skill.id, name: 'pdf-tools' },
    });

    await call('PATCH', `/api/skills/${skill.id}`, { body: 'local edit' });
    const replaced = await call('POST', `/api/skill-sources/${id}/import`, {
      slug: 'pdf-tools',
      confirmUntrusted: true,
      replaceExisting: true,
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json()).toMatchObject({
      replaced: true,
      skill: { id: skill.id, name: 'pdf-tools' },
    });
    expect(replaced.json().skill.body).toContain('# PDF tools');
    expect(await ctx.database.collections.skills.countDocuments()).toBe(1);

    const audits = await ctx.database.collections.audit
      .find({ action: 'skill.imported' })
      .sort({ _id: 1 })
      .toArray();
    expect(audits.map((entry) => entry.details['replaced'])).toEqual([false, true]);
    expect(audits[0]?.details).toMatchObject({
      skillId: skill.id,
      sourceId: id,
      slug: 'pdf-tools',
    });
    expect(logs).not.toContain(PRO_KEY);
  });

  it('reports a name clash and imports under another name', async () => {
    await call('POST', '/api/skills', { name: 'release-notes', description: 'Mine' });
    const id = await source('Pro 2', PRO_KEY);
    const clash = await call('POST', `/api/skill-sources/${id}/import`, {
      slug: 'release-notes',
      confirmUntrusted: true,
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error).toBe('conflict');
    const renamed = await call('POST', `/api/skill-sources/${id}/import`, {
      slug: 'release-notes',
      name: 'release-notes-directory',
      confirmUntrusted: true,
    });
    expect(renamed.statusCode).toBe(201);
    const invalid = await call('POST', `/api/skill-sources/${id}/import`, {
      slug: 'pdf-tools',
      name: 'Not Valid',
      confirmUntrusted: true,
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({
      error: 'invalid_name',
      details: { suggestion: 'pdf-tools' },
    });
  });

  it('remembers a rate limit until it resets instead of calling again', async () => {
    const id = await source('Limited', LIMITED_KEY);
    const first = await call('GET', `/api/skill-sources/${id}/skills`);
    expect(first.statusCode).toBe(429);
    expect(first.json()).toMatchObject({
      error: 'directory_rate_limited',
      details: { resetAt: RESET_AT },
    });
    const count = fake.requests.length;
    const second = await call('GET', `/api/skill-sources/${id}/categories`);
    expect(second.statusCode).toBe(429);
    expect(second.json().details.resetAt).toBe(RESET_AT);
    expect(fake.requests.length).toBe(count);
  });

  it('refuses to browse a disabled source', async () => {
    const id = await source('Disabled', FREE_KEY);
    await call('PATCH', `/api/skill-sources/${id}`, { enabled: false });
    const response = await call('GET', `/api/skill-sources/${id}/skills`);
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('directory_disabled');
  });
});
