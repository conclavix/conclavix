import { readFileSync } from 'node:fs';
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RESERVED_SECRET_ENV_NAMES,
  RESERVED_SECRET_ENV_PREFIXES,
  secretEnvNameProblem,
} from '@conclavix/core';
import { SecretBox, vaultBox } from '../src/modules/settings/secret-box.js';
import { secretContext } from '../src/modules/secrets/repository.js';
import { AUTH_SECRET, createTestContext, type TestContext } from './helpers.js';
import { asBrowser, createUser, PASSWORD, signIn } from './auth-helpers.js';

const VALUE = 'sk_test_vault-value-0123456789abcdef';

describe('project secrets', () => {
  let ctx: TestContext;
  let projectId: string;
  let coderId: string;
  const cookies: Record<string, string> = {};

  const as = (
    role: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) => asBrowser(ctx, cookies[role] ?? '', { method, url, ...(payload ? { payload } : {}) });
  const base = () => `/api/projects/${projectId}/secrets`;

  beforeAll(async () => {
    ctx = await createTestContext({ settingsDefaults: { mfaPolicy: 'optional' } });
    for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
      await createUser(ctx, `${role}@example.com`, role);
      cookies[role] = (await signIn(ctx, `${role}@example.com`)).cookie;
    }
    projectId = (
      await ctx.request({
        method: 'POST',
        url: '/api/projects',
        payload: { key: 'VLT', name: 'Vault', autoPlan: false },
      })
    ).json().id as string;
    coderId = (
      await ctx.request({
        method: 'POST',
        url: '/api/agents',
        payload: {
          name: 'Coder',
          role: 'engineer',
          adapter: { type: 'claude_cli' },
          codeAccess: 'write',
        },
      })
    ).json().id as string;
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('stores the value encrypted, bound to its record, and never returns it', async () => {
    const created = await as('admin', 'POST', base(), {
      name: 'Stripe test key',
      envName: 'STRIPE_TEST_KEY',
      value: VALUE,
      agentIds: [coderId],
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain(VALUE);
    expect(created.json()).toMatchObject({ envName: 'STRIPE_TEST_KEY', agentIds: [coderId] });

    const raw = await ctx.database.collections.secrets.findOne({ envName: 'STRIPE_TEST_KEY' });
    if (!raw) throw new Error('expected the stored secret');
    expect(JSON.stringify(raw)).not.toContain(VALUE);
    expect(vaultBox(AUTH_SECRET).open(raw.valueEncrypted, secretContext(raw._id))).toBe(VALUE);
    // Another key (the settings box) or another record cannot open it.
    expect(() =>
      new SecretBox(AUTH_SECRET).open(raw.valueEncrypted, secretContext(raw._id)),
    ).toThrow();
    expect(() =>
      vaultBox(AUTH_SECRET).open(raw.valueEncrypted, secretContext(new ObjectId())),
    ).toThrow();

    const listed = await as('admin', 'GET', base());
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(VALUE);
    expect(listed.json().agents).toEqual(
      expect.arrayContaining([{ id: coderId, name: 'Coder', codeAccess: 'write' }]),
    );
  });

  it('lets only owners and admins manage secrets', async () => {
    for (const role of ['member', 'viewer']) {
      expect((await as(role, 'GET', base())).statusCode).toBe(403);
      const denied = await as(role, 'POST', base(), {
        name: 'x',
        envName: 'X_VALUE',
        value: VALUE,
      });
      expect(denied.statusCode).toBe(403);
    }
    const created = await as('owner', 'POST', base(), {
      name: 'Owner made',
      envName: 'OWNER_MADE',
      value: VALUE,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const replaced = await as('admin', 'PATCH', `${base()}/${id}`, {
      value: 'a-new-value-0987654321',
      agentIds: [coderId],
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.body).not.toContain('a-new-value');
    expect((await as('member', 'DELETE', `${base()}/${id}`)).statusCode).toBe(403);
    expect((await as('admin', 'DELETE', `${base()}/${id}`)).statusCode).toBe(204);
  });

  it('reveals the value only to an owner who enters the password again', async () => {
    const secret = await ctx.database.collections.secrets.findOne({ envName: 'STRIPE_TEST_KEY' });
    const url = `${base()}/${secret?._id.toHexString()}/reveal`;
    const admin = await as('admin', 'POST', url, { password: PASSWORD });
    expect(admin.statusCode).toBe(403);
    expect(admin.json().error).toBe('owner_required');
    const board = await ctx.request({ method: 'POST', url, payload: { password: PASSWORD } });
    expect(board.json().error).toBe('reauth_required');

    const wrong = await as('owner', 'POST', url, { password: 'not the password' });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error).toBe('invalid_password');
    expect(wrong.body).not.toContain(VALUE);

    const shown = await as('owner', 'POST', url, { password: PASSWORD });
    expect(shown.statusCode).toBe(200);
    expect(shown.json()).toEqual({ value: VALUE });
    expect(shown.headers['cache-control']).toBe('no-store');

    const actions = await ctx.database.collections.audit
      .find({ action: { $in: ['secret.reveal_failed', 'secret.revealed'] } })
      .toArray();
    expect(actions.map((entry) => entry.action).sort()).toEqual([
      'secret.reveal_failed',
      'secret.revealed',
    ]);
  });

  it('pauses reveals after repeated wrong passwords', async () => {
    const created = await as('owner', 'POST', base(), {
      name: 'Limited',
      envName: 'LIMITED_VALUE',
      value: VALUE,
    });
    const url = `${base()}/${created.json().id as string}/reveal`;
    await createUser(ctx, 'owner2@example.com', 'owner');
    const cookie = (await signIn(ctx, 'owner2@example.com')).cookie;
    const attempt = (password: string) =>
      asBrowser(ctx, cookie, { method: 'POST', url, payload: { password } });
    for (let i = 0; i < 5; i += 1) expect((await attempt('wrong')).statusCode).toBe(403);
    expect((await attempt(PASSWORD)).statusCode).toBe(429);
  });

  it('refuses reserved, malformed and duplicate variable names and short values', async () => {
    for (const envName of [
      'PATH',
      'HOME',
      'LD_PRELOAD',
      'NODE_OPTIONS',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'CONCLAVIX_RUN_BEARER',
      'CVX_SECRET_CEO',
      'lower_case',
      '1START',
      'WITH-DASH',
    ]) {
      const response = await as('admin', 'POST', base(), { name: envName, envName, value: VALUE });
      expect(response.statusCode, envName).toBe(400);
    }
    const short = await as('admin', 'POST', base(), { name: 's', envName: 'SHORT', value: 'abc' });
    expect(short.statusCode).toBe(400);
    const duplicate = await as('admin', 'POST', base(), {
      name: 'Another name',
      envName: 'STRIPE_TEST_KEY',
      value: VALUE,
    });
    expect(duplicate.statusCode).toBe(409);
    const unknownAgent = await as('admin', 'POST', base(), {
      name: 'Unknown agent',
      envName: 'UNKNOWN_AGENT',
      value: VALUE,
      agentIds: [new ObjectId().toHexString()],
    });
    expect(unknownAgent.statusCode).toBe(422);
  });

  it('audits every change without the value', async () => {
    const entries = await ctx.database.collections.audit.find({ action: /^secret\./ }).toArray();
    const actions = new Set(entries.map((entry) => entry.action));
    for (const action of [
      'secret.created',
      'secret.updated',
      'secret.deleted',
      'secret.revealed',
    ]) {
      expect(actions.has(action), action).toBe(true);
    }
    const stored = JSON.stringify(entries);
    expect(stored).not.toContain(VALUE);
    expect(stored).not.toContain('a-new-value');
    const updated = entries.find((entry) => entry.action === 'secret.updated');
    expect(updated?.details).toMatchObject({
      changes: { value: 'replaced', agentsAdded: [coderId] },
    });
  });
});

describe('reserved secret names', () => {
  const script = readFileSync(
    new URL('../../../deploy/agent-sandbox/agent-exec.sh', import.meta.url),
    'utf8',
  );
  const pattern = (name: string) =>
    new RegExp(new RegExp(`^readonly ${name}='([^']+)'$`, 'm').exec(script)?.[1] ?? '^$');
  const reserved = pattern('reserved');
  const projectSecret = pattern('project_secret');

  it('match between the API and the sandbox wrapper', () => {
    for (const name of RESERVED_SECRET_ENV_NAMES) {
      expect(reserved.test(name), name).toBe(true);
      expect(secretEnvNameProblem(name), name).not.toBeNull();
    }
    for (const prefix of RESERVED_SECRET_ENV_PREFIXES) {
      const name = `${prefix.replace(/_$/, '')}_X1`;
      expect(reserved.test(name), name).toBe(true);
      expect(secretEnvNameProblem(name), name).not.toBeNull();
    }
    for (const name of ['STRIPE_TEST_KEY', 'API_BASE_URL', 'DATABASE_URL', 'X', 'PAYPAL_SECRET']) {
      expect(secretEnvNameProblem(name), name).toBeNull();
      expect(projectSecret.test(name) && !reserved.test(name), name).toBe(true);
    }
  });
});
