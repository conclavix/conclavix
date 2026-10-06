import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';
import { asBrowser, createUser, signIn } from './auth-helpers.js';

const AGENT = {
  name: 'Coder',
  role: 'engineer',
  adapter: { type: 'claude_cli' },
};

describe('agent code access', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext({ settingsDefaults: { mfaPolicy: 'optional' } });
  });
  afterEach(async () => {
    await ctx.close();
  });

  const auditEntries = () =>
    ctx.database.collections.audit
      .find({ action: 'agent.code_access_changed' })
      .sort({ _id: 1 })
      .toArray();

  it('defaults to none, also for agents stored without the field', async () => {
    const created = await ctx.request({ method: 'POST', url: '/api/agents', payload: AGENT });
    expect(created.statusCode).toBe(201);
    expect(created.json().codeAccess).toBe('none');
    await ctx.database.collections.agents.updateMany({}, { $unset: { codeAccess: '' } });
    const read = await ctx.request({ method: 'GET', url: `/api/agents/${created.json().id}` });
    expect(read.json().codeAccess).toBe('none');
    expect(await auditEntries()).toHaveLength(0);
  });

  it('audits granting and revoking write access, and creating a writing agent', async () => {
    const created = await ctx.request({ method: 'POST', url: '/api/agents', payload: AGENT });
    const id = created.json().id as string;
    const grant = await ctx.request({
      method: 'PATCH',
      url: `/api/agents/${id}`,
      payload: { codeAccess: 'write' },
    });
    expect(grant.json().codeAccess).toBe('write');
    await ctx.request({
      method: 'PATCH',
      url: `/api/agents/${id}`,
      payload: { codeAccess: 'write' },
    });
    await ctx.request({
      method: 'PATCH',
      url: `/api/agents/${id}`,
      payload: { codeAccess: 'none' },
    });
    await ctx.request({
      method: 'POST',
      url: '/api/agents',
      payload: { ...AGENT, name: 'Builder', codeAccess: 'write' },
    });
    const entries = await auditEntries();
    expect(
      entries.map((entry) => [entry.details['agent'], entry.details['from'], entry.details['to']]),
    ).toEqual([
      ['Coder', 'none', 'write'],
      ['Coder', 'write', 'none'],
      ['Builder', 'none', 'write'],
    ]);
  });

  it('rejects unknown values', async () => {
    const created = await ctx.request({ method: 'POST', url: '/api/agents', payload: AGENT });
    const response = await ctx.request({
      method: 'PATCH',
      url: `/api/agents/${created.json().id}`,
      payload: { codeAccess: 'root' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('lets only admins and owners change it', async () => {
    const created = await ctx.request({ method: 'POST', url: '/api/agents', payload: AGENT });
    for (const [role, status] of [
      ['member', 403],
      ['viewer', 403],
      ['admin', 200],
    ] as const) {
      await createUser(ctx, `${role}@example.com`, role);
      const { cookie } = await signIn(ctx, `${role}@example.com`);
      const response = await asBrowser(ctx, cookie, {
        method: 'PATCH',
        url: `/api/agents/${created.json().id}`,
        payload: { codeAccess: 'write' },
      });
      expect(response.statusCode, role).toBe(status);
    }
  });
});
