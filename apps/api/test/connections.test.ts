import { fileURLToPath } from 'node:url';
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vaultBox } from '../src/modules/settings/secret-box.js';
import { claudeArgs, codeClaudeArgs } from '../src/runner/adapters/claude-cli.js';
import { sandboxCommand } from '../src/runner/adapters/sandbox.js';
import type { AdapterRunInput } from '../src/runner/adapters/types.js';
import { assertUnchanged, loadRunConnections } from '../src/runner/run-connections.js';
import { RunWorker } from '../src/runner/run-worker.js';
import type { CodeRuns } from '../src/runner/code-run.js';
import { AuditLog } from '../src/modules/audit/audit.js';
import pino from 'pino';
import { createFixture } from './scheduler-helpers.js';
import { asBrowser, createUser, signIn } from './auth-helpers.js';
import { startFakeMcpServer, type FakeMcpServer } from './fixtures/fake-mcp-server.js';
import { AUTH_SECRET, createTestContext, type TestContext } from './helpers.js';

const TOKEN = 'mcp-header-secret-0123456789abcdef';
const HELPER_ARGS = fileURLToPath(
  new URL('../../../deploy/agent-sandbox/args.mjs', import.meta.url),
);

describe('connections', () => {
  let ctx: TestContext;
  let mcp: FakeMcpServer;
  let echo: FakeMcpServer;
  let projectId: string;
  let otherProjectId: string;
  let coderId: string;
  let readerId: string;
  const cookies: Record<string, string> = {};

  const as = (
    role: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) => asBrowser(ctx, cookies[role] ?? '', { method, url, ...(payload ? { payload } : {}) });

  const create = (role: string, payload: object) => as(role, 'POST', '/api/connections', payload);

  beforeAll(async () => {
    ctx = await createTestContext({ settingsDefaults: { mfaPolicy: 'optional' } });
    mcp = await startFakeMcpServer(`Bearer ${TOKEN}`);
    echo = await startFakeMcpServer('Bearer something-else-entirely', 1, true);
    for (const role of ['owner', 'admin', 'member'] as const) {
      await createUser(ctx, `${role}@example.com`, role);
      cookies[role] = (await signIn(ctx, `${role}@example.com`)).cookie;
    }
    const project = async (key: string) =>
      (
        await ctx.request({
          method: 'POST',
          url: '/api/projects',
          payload: { key, name: key, autoPlan: false },
        })
      ).json().id as string;
    projectId = await project('CON');
    otherProjectId = await project('OTR');
    const agent = async (name: string, codeAccess: 'none' | 'write') =>
      (
        await ctx.request({
          method: 'POST',
          url: '/api/agents',
          payload: { name, role: 'engineer', adapter: { type: 'claude_cli' }, codeAccess },
        })
      ).json().id as string;
    coderId = await agent('Coder', 'write');
    readerId = await agent('Reader', 'none');
  });

  afterAll(async () => {
    await mcp.close();
    await echo.close();
    await ctx.close();
  });

  const docsPayload = (extra: object = {}) => ({
    name: 'docs',
    type: 'mcp_http',
    scope: 'instance',
    config: { url: mcp.url, headers: ['Authorization'] },
    credentials: { Authorization: `Bearer ${TOKEN}` },
    agentIds: [coderId, readerId],
    allowPrivateNetwork: true,
    ...extra,
  });

  it('keeps private networks closed unless an owner opens them', async () => {
    const plain = await create('admin', docsPayload({ allowPrivateNetwork: false }));
    expect(plain.statusCode).toBe(422);
    expect(plain.json().error).toBe('connection_url_invalid');
    const loopback = await create(
      'admin',
      docsPayload({
        allowPrivateNetwork: false,
        config: { url: 'https://127.0.0.1/mcp', headers: ['Authorization'] },
      }),
    );
    expect(loopback.json().error).toBe('connection_address_blocked');
    const admin = await create('admin', docsPayload());
    expect(admin.statusCode).toBe(403);
    expect(admin.json().error).toBe('owner_required');

    const created = await create('owner', docsPayload());
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain(TOKEN);
    expect(created.json()).toMatchObject({
      name: 'docs',
      scope: 'instance',
      credentials: [{ key: 'Authorization', set: true }],
      allowPrivateNetwork: true,
    });
    const stored = await ctx.database.collections.secrets.findOne({ name: 'docs:Authorization' });
    expect(stored).toMatchObject({ envName: null, projectId: null, agentIds: [] });
    expect(JSON.stringify(stored)).not.toContain(TOKEN);
  });

  it('describes the types with a JSON schema for the form', async () => {
    const listed = await as('admin', 'GET', '/api/connections');
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(TOKEN);
    const type = listed.json().types.find((entry: { id: string }) => entry.id === 'mcp_http');
    expect(type).toMatchObject({ credentialsField: 'headers', providesMcpServer: true });
    expect(type.configSchema.properties.url).toMatchObject({ type: 'string', format: 'uri' });
    expect((await as('member', 'GET', '/api/connections')).statusCode).toBe(403);
  });

  it('tests the server with MCP initialize and tools/list', async () => {
    const id = (await ctx.database.collections.connections.findOne({ name: 'docs' }))?._id;
    const tested = await as('admin', 'POST', `/api/connections/${id?.toHexString()}/test`);
    expect(tested.statusCode).toBe(200);
    expect(tested.json().lastTest).toMatchObject({
      ok: true,
      summary: 'Connected to fake-docs: 3 tools',
    });
    expect(mcp.seen.map((entry) => entry.method)).toEqual(
      expect.arrayContaining(['initialize', 'tools/list']),
    );
    expect(mcp.seen.every((entry) => entry.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('clears the last test result on credential changes and detects concurrent edits', async () => {
    const docs = await ctx.database.collections.connections.findOne({ name: 'docs' });
    expect(docs?.lastTest?.ok).toBe(true);
    const id = docs?._id.toHexString() ?? '';
    const changed = await as('owner', 'PATCH', `/api/connections/${id}`, {
      credentials: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(changed.json().lastTest).toBeNull();
    await as('admin', 'POST', `/api/connections/${id}/test`);
    // A connection edited between reading it and its credentials is refused.
    if (!docs) throw new Error('expected docs');
    await expect(
      assertUnchanged(ctx.database.collections, { ...docs, updatedAt: new Date(0) }),
    ).rejects.toThrow(/changed/);
    const fresh = await ctx.database.collections.connections.findOne({ _id: docs._id });
    await expect(assertUnchanged(ctx.database.collections, fresh ?? docs)).resolves.toBeUndefined();
  });

  it('reports refused credentials and never stores an echoed value', async () => {
    const wrong = await create(
      'owner',
      docsPayload({
        name: 'wrong',
        credentials: { Authorization: 'Bearer wrong-value-0123456789' },
      }),
    );
    const failed = await as('admin', 'POST', `/api/connections/${wrong.json().id as string}/test`);
    expect(failed.json().lastTest).toMatchObject({
      ok: false,
      summary: 'the server refused the credentials (HTTP 401)',
    });
    const echoing = await create(
      'owner',
      docsPayload({
        name: 'echo',
        config: { url: echo.url, headers: ['Authorization'] },
      }),
    );
    const echoed = await as(
      'admin',
      'POST',
      `/api/connections/${echoing.json().id as string}/test`,
    );
    expect(echoed.json().lastTest.ok).toBe(false);
    expect(echoed.body).not.toContain(TOKEN);
    const doc = await ctx.database.collections.connections.findOne({ name: 'echo' });
    expect(JSON.stringify(doc)).not.toContain(TOKEN);
  });

  it('validates names, types, configs, credentials and scope', async () => {
    const cases: [object, number][] = [
      [docsPayload({ name: 'conclavix' }), 400],
      [docsPayload({ name: 'Docs' }), 400],
      [docsPayload(), 409],
      [docsPayload({ name: 'x1', type: 'paypal' }), 422],
      [docsPayload({ name: 'x2', config: { url: mcp.url, headers: ['Host'] } }), 400],
      [docsPayload({ name: 'x3', config: { url: 'ftp://example.com/' } }), 400],
      [docsPayload({ name: 'x6', projectId }), 400],
    ];
    for (const [payload, status] of cases) {
      const response = await create('owner', payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(status);
    }
  });

  it('drops stored credentials when the URL changes and keeps admins off private ones', async () => {
    const created = await create(
      'owner',
      docsPayload({
        name: 'moving',
        allowPrivateNetwork: false,
        config: { url: 'https://mcp.example.com/mcp', headers: ['Authorization'] },
      }),
    );
    const id = created.json().id as string;
    const moved = await as('admin', 'PATCH', `/api/connections/${id}`, {
      config: { url: 'https://other.example.com/mcp', headers: ['Authorization'] },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().credentials).toEqual([{ key: 'Authorization', set: false }]);
    const audit = await ctx.database.collections.audit.findOne({
      action: 'connection.updated',
      'details.connectionId': id,
    });
    expect(audit?.details).toMatchObject({
      changes: { config: true, credentials: ['Authorization'] },
    });

    const docs = await ctx.database.collections.connections.findOne({ name: 'docs' });
    const locked = await as('admin', 'PATCH', `/api/connections/${docs?._id.toHexString()}`, {
      config: { url: 'http://127.0.0.1:1/mcp', headers: ['Authorization'] },
    });
    expect(locked.statusCode).toBe(403);
    const agentsOnly = await as('admin', 'PATCH', `/api/connections/${docs?._id.toHexString()}`, {
      agentIds: [coderId, readerId],
    });
    expect(agentsOnly.statusCode).toBe(200);
  });

  it('injects only allowed connections into a run, with header values as references', async () => {
    const projectConnection = await create(
      'owner',
      docsPayload({
        name: 'other-project',
        scope: 'project',
        projectId: otherProjectId,
      }),
    );
    expect(projectConnection.statusCode).toBe(201);
    const box = vaultBox(AUTH_SECRET);
    const coder = await loadRunConnections(
      ctx.database.collections,
      box,
      new ObjectId(coderId),
      new ObjectId(projectId),
    );
    const docs = coder.servers.find((server) => server.name === 'docs');
    expect(docs).toBeDefined();
    const [variable] = Object.values(docs?.headers ?? {});
    expect(variable).toMatch(/^\$\{CONCLAVIX_MCP_HEADER_\d+\}$/);
    expect(coder.env[variable?.slice(2, -1) ?? '']).toBe(`Bearer ${TOKEN}`);
    expect(coder.servers.map((server) => server.name)).not.toContain('other-project');
    expect(coder.privateAddresses).toEqual(['127.0.0.1']);
    expect(coder.known.map((entry) => entry.value)).toEqual(
      expect.arrayContaining([`Bearer ${TOKEN}`, TOKEN]),
    );
    expect(coder.skipped.map((entry) => entry.name)).toContain('moving');

    const elsewhere = await loadRunConnections(
      ctx.database.collections,
      box,
      new ObjectId(coderId),
      new ObjectId(otherProjectId),
    );
    expect(elsewhere.servers.map((server) => server.name)).toContain('other-project');
    const nobody = await loadRunConnections(
      ctx.database.collections,
      box,
      new ObjectId(),
      new ObjectId(projectId),
    );
    expect(nobody.servers).toEqual([]);

    const input = {
      run: { _id: new ObjectId(), maxCostPerRunUsd: 1 },
      agent: { adapter: { type: 'claude_cli' } },
      mcpUrl: 'http://127.0.0.1:3300/mcp',
      timeoutMs: 600_000,
      mcpServers: coder.servers,
      allowAddresses: coder.privateAddresses,
    } as unknown as AdapterRunInput;
    const readOnly = claudeArgs(input);
    expect(readOnly[readOnly.indexOf('--allowedTools') + 1]).toContain('mcp__docs');
    expect(readOnly.join(' ')).not.toContain(TOKEN);
    const coding = codeClaudeArgs(input);
    expect(coding.join(' ')).not.toContain(TOKEN);
    const helper = (await import(HELPER_ARGS)) as {
      parseRunArgs: (argv: string[]) => { mcpServers: string[]; allowAddresses: string[] };
    };
    const command = sandboxCommand(
      {
        helper: '/usr/local/libexec/conclavix/agent-run.mjs',
        sudo: '/usr/bin/sudo',
        limits: { memoryMax: '4G', cpuQuotaPercent: 200, tasksMax: 512, diskLimitMb: 4096 },
        extraDomains: [],
      },
      input,
      { projectId: new ObjectId().toHexString(), issueKey: 'CON-1', skillsDir: null },
      coding,
      'a'.repeat(32),
    );
    const parsed = helper.parseRunArgs(command.args.slice(2));
    expect(parsed.mcpServers).toEqual(expect.arrayContaining(['conclavix', 'docs']));
    expect(parsed.allowAddresses).toEqual(['127.0.0.1']);
  });

  it('gives a run the servers, redacts header values and audits the use', async () => {
    const fx = await createFixture(ctx);
    const seen: AdapterRunInput[] = [];
    const worker = new RunWorker(ctx.database, fx.scheduler, {
      workspacesRoot: `/tmp/cvx-connections-${new ObjectId().toHexString()}`,
      mcpUrl: 'http://127.0.0.1:9/mcp',
      timeoutMs: 10_000,
      secretBox: vaultBox(AUTH_SECRET),
      audit: new AuditLog(ctx.database.collections, pino({ level: 'silent' })),
      codeRuns: {
        prepare: async (issue: { key: string }) => ({
          projectId: fx.projectId,
          issueKey: issue.key,
          skillsDir: null,
          branch: `cvx/${issue.key}`,
          base: null,
        }),
        finish: async () => ({}),
      } as unknown as CodeRuns,
      adapters: {
        claude_cli: {
          run: async (input) => {
            seen.push(input);
            input.onEvent('assistant', `header is ${Object.values(input.mcpEnv ?? {}).join(',')}`);
            return { status: 'succeeded', costUsd: 0 };
          },
        },
      },
    });
    const issue = await fx.issue({ title: 'use docs', assigneeAgentId: coderId });
    await fx.scheduler.processPendingWakes();
    const run = await ctx.database.collections.runs.findOne({ issueId: new ObjectId(issue.id) });
    if (!run) throw new Error('expected a run');
    await worker.process(run._id);
    expect(seen[0]?.mcpServers?.map((server) => server.name)).toContain('docs');
    expect(seen[0]?.allowAddresses).toEqual(['127.0.0.1']);
    const events = JSON.stringify(
      await ctx.database.collections.runEvents.find({ runId: run._id }).toArray(),
    );
    expect(events).not.toContain(TOKEN);
    expect(events).toContain('[redacted:docs:Authorization]');
    expect(events).toContain('connection moving left out: no value stored for Authorization');
    const used = await ctx.database.collections.audit.findOne({
      action: 'connection.used',
      'details.runId': run._id.toHexString(),
      'details.name': 'docs',
    });
    expect(used?.details).toMatchObject({ name: 'docs', agentId: coderId });
  });

  it('gives a run at most eight connection servers', async () => {
    const agent = (
      await ctx.request({
        method: 'POST',
        url: '/api/agents',
        payload: { name: 'Many', role: 'engineer', adapter: { type: 'claude_cli' } },
      })
    ).json().id as string;
    for (let index = 0; index < 9; index += 1) {
      const created = await create(
        'owner',
        docsPayload({
          name: `many-${index}`,
          config: { url: mcp.url, headers: [] },
          credentials: {},
          agentIds: [agent],
        }),
      );
      expect(created.statusCode).toBe(201);
    }
    const loaded = await loadRunConnections(
      ctx.database.collections,
      vaultBox(AUTH_SECRET),
      new ObjectId(agent),
      new ObjectId(projectId),
    );
    expect(loaded.servers).toHaveLength(8);
    expect(loaded.skipped).toEqual([{ name: 'many-8', cause: 'more than 8 servers in one run' }]);
  });

  it('audits changes and tests without credential values', async () => {
    const id = (await ctx.database.collections.connections.findOne({ name: 'wrong' }))?._id;
    expect((await as('admin', 'DELETE', `/api/connections/${id?.toHexString()}`)).statusCode).toBe(
      204,
    );
    expect(
      await ctx.database.collections.secrets.countDocuments({ connectionId: id ?? new ObjectId() }),
    ).toBe(0);
    const entries = await ctx.database.collections.audit
      .find({ action: /^connection\./ })
      .toArray();
    const actions = new Set(entries.map((entry) => entry.action));
    for (const action of [
      'connection.created',
      'connection.updated',
      'connection.deleted',
      'connection.tested',
    ]) {
      expect(actions.has(action), action).toBe(true);
    }
    expect(JSON.stringify(entries)).not.toContain(TOKEN);
  });
});
