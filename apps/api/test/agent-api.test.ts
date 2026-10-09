import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ObjectId } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOARD_TOKEN, createTestContext, type TestContext } from './helpers.js';
import { createFixture, type Fixture } from './scheduler-helpers.js';

type ToolResponse = { isError?: boolean; content: { type: string; text: string }[] };

describe('agent API over MCP', () => {
  let ctx: TestContext;
  let fx: Fixture;
  let baseUrl: string;
  let ceo: { id: string };
  let engineer: { id: string };
  let outsider: { id: string };
  let epic: { id: string; key: string };

  const connect = async (token: string): Promise<Client> => {
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await client.connect(transport as Parameters<Client['connect']>[0]);
    return client;
  };
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as ToolResponse;
    return {
      isError: result.isError === true,
      data: JSON.parse(result.content[0]?.text ?? 'null'),
    };
  };
  const startRunFor = async (issueId: string) => {
    await fx.scheduler.processPendingWakes();
    const run = await ctx.database.collections.runs.findOne({
      issueId: new ObjectId(issueId),
      status: 'queued',
    });
    if (!run) throw new Error('expected a queued run');
    const { token } = await fx.scheduler.startRun(run._id, 60_000);
    return { run, token };
  };

  beforeEach(async () => {
    ctx = await createTestContext();
    baseUrl = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    fx = await createFixture(ctx);
    ceo = await fx.agent({ role: 'ceo' });
    engineer = await fx.agent({ reportsTo: ceo.id });
    outsider = await fx.agent();
    epic = await fx.issue({ title: 'Ship the feedback module', assigneeAgentId: ceo.id });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await ctx.close();
  });

  it('serves the tools to a running run and scopes them to its issue', async () => {
    const { token } = await startRunFor(epic.id);
    const client = await connect(token);
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(tools).toEqual([
      'add_comment',
      'create_subissue',
      'get_issue',
      'list_documents',
      'list_notifications',
      'list_team',
      'mark_notifications_read',
      'memory_save',
      'memory_search',
      'read_document',
      'reopen_issue',
      'request_board_decision',
      'set_status',
      'write_document',
    ]);

    const own = await call(client, 'get_issue');
    expect(own.data.issue.key).toBe(epic.key);

    const comment = await call(client, 'add_comment', { body: 'Planning now.' });
    expect(comment.data.author).toEqual({ type: 'agent', agentId: ceo.id });
    expect(
      await ctx.database.collections.wakes.countDocuments({
        issueId: new ObjectId(epic.id),
        processedAt: null,
      }),
    ).toBe(0);

    const team = await call(client, 'list_team');
    expect(team.data.canDelegateTo.map((member: { id: string }) => member.id)).toEqual([
      engineer.id,
    ]);
    expect(team.data.reportsTo).toEqual([]);
    await client.close();
  });

  it('delegates only down the org chart and wakes the delegate', async () => {
    const { token } = await startRunFor(epic.id);
    const client = await connect(token);

    const delegated = await call(client, 'create_subissue', {
      title: 'Build the API',
      assigneeAgentId: engineer.id,
    });
    expect(delegated.isError).toBe(false);
    expect(delegated.data).toMatchObject({ parentId: epic.id, assigneeAgentId: engineer.id });
    expect(
      await ctx.database.collections.wakes.countDocuments({
        agentId: new ObjectId(engineer.id),
        processedAt: null,
      }),
    ).toBe(1);

    const sideways = await call(client, 'create_subissue', {
      title: 'Not yours',
      assigneeAgentId: outsider.id,
    });
    expect(sideways.isError).toBe(true);
    expect(sideways.data.error).toMatch(/delegate to agents you have a link to/);

    const closeTooEarly = await call(client, 'set_status', { status: 'done' });
    expect(closeTooEarly.isError).toBe(true);
    expect((await call(client, 'set_status', { status: 'in_review' })).data.status).toBe(
      'in_review',
    );
    await client.close();
  });

  it('moves the issue to a column of the new status when an agent sets it', async () => {
    const columns = [
      { id: 'backlog', title: 'Backlog', status: 'backlog' },
      { id: 'todo', title: 'To do', status: 'todo' },
      { id: 'doing', title: 'Doing', status: 'in_progress' },
      { id: 'qa', title: 'QA', status: 'in_review' },
      { id: 'in_review', title: 'In review', status: 'in_review' },
      { id: 'done', title: 'Done', status: 'done' },
      { id: 'cancelled', title: 'Cancelled', status: 'cancelled' },
    ];
    const board = await ctx.request({
      method: 'PUT',
      url: `/api/projects/${fx.projectId}/board`,
      payload: { revision: 0, columns },
    });
    expect(board.statusCode).toBe(200);
    const { token } = await startRunFor(epic.id);
    const client = await connect(token);
    const review = await call(client, 'set_status', { status: 'in_review' });
    expect(review.data).toMatchObject({ status: 'in_review', columnId: 'qa' });
    const own = await call(client, 'get_issue');
    expect(own.data.issue.columnId).toBe('qa');
    await client.close();
  });

  it('versions documents and reads parent documents from a sub-issue run', async () => {
    const parent = await startRunFor(epic.id);
    const ceoClient = await connect(parent.token);
    expect(
      (await call(ceoClient, 'write_document', { key: 'plan', body: 'v1', title: 'Plan' })).data
        .revision,
    ).toBe(1);
    const stale = await call(ceoClient, 'write_document', { key: 'plan', body: 'v2' });
    expect(stale.isError).toBe(true);
    expect(stale.data.details).toEqual({ currentRevision: 1 });
    await ceoClient.close();

    const sub = await fx.issue({
      title: 'Build the API',
      parentId: epic.id,
      assigneeAgentId: engineer.id,
    });
    const { token } = await startRunFor(sub.id);
    const engineerClient = await connect(token);
    const parentPlan = await call(engineerClient, 'read_document', { key: 'plan', ref: epic.key });
    expect(parentPlan.data).toMatchObject({ body: 'v1', revision: 1 });

    const other = await fx.issue({ title: 'sibling' });
    await ctx.request({
      method: 'PUT',
      url: `/api/issues/${other.key}/documents/plan`,
      payload: { body: 'not for you' },
    });
    const sibling = await call(engineerClient, 'read_document', { key: 'plan', ref: other.key });
    expect(sibling.isError).toBe(true);
    expect(sibling.data.error).toMatch(/your issue tree only/);

    const foreignProject = await createFixture(ctx);
    const foreign = await foreignProject.issue({ title: 'elsewhere' });
    expect((await call(engineerClient, 'get_issue', { ref: foreign.key })).isError).toBe(true);
    await engineerClient.close();
  });

  it('validates optional issue references before looking them up', async () => {
    const { token } = await startRunFor(epic.id);
    const client = await connect(token);
    try {
      for (const name of ['get_issue', 'read_document']) {
        for (const ref of ['', 'malformed', 'CVX-0', new ObjectId().toHexString()]) {
          const result = await client.callTool({
            name,
            arguments: { ref, ...(name === 'read_document' ? { key: 'plan' } : {}) },
          });
          expect(result.isError).toBe(true);
          expect(JSON.stringify(result.content)).toMatch(/validation/i);
        }
      }
      expect((await call(client, 'get_issue', { ref: epic.key })).data.issue.key).toBe(epic.key);
    } finally {
      await client.close();
    }
  });

  it('rejects board tokens, finished runs and expired tokens; run tokens cannot use the board API', async () => {
    const boardOnMcp = await ctx.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${BOARD_TOKEN}`, 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(boardOnMcp.statusCode).toBe(401);

    const task = await fx.issue({ title: 'short lived', assigneeAgentId: outsider.id });
    const { run, token } = await startRunFor(task.id);
    const runOnBoard = await ctx.app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(runOnBoard.statusCode).toBe(401);

    await fx.scheduler.finishRun(run._id, { status: 'succeeded', costUsd: 0 });
    await expect(connect(token)).rejects.toThrow();

    const later = await fx.issue({ title: 'expires', assigneeAgentId: outsider.id });
    await fx.scheduler.processPendingWakes();
    const queued = await ctx.database.collections.runs.findOne({
      issueId: new ObjectId(later.id),
      status: 'queued',
    });
    if (!queued) throw new Error('expected a queued run');
    const expired = await fx.scheduler.startRun(queued._id, 1, new Date(Date.now() - 1000));
    await expect(connect(expired.token)).rejects.toThrow();
  });

  it.each(['get_issue', 'read_document'])(
    'rejects malformed refs before %s reaches the database',
    async (name) => {
      const { token } = await startRunFor(epic.id);
      const client = await connect(token);
      const lookup = vi.spyOn(ctx.database.collections.issues, 'findOne');
      try {
        for (const ref of ['invalid', 'CVX-0', '', new ObjectId().toHexString()]) {
          lookup.mockClear();
          const response = await client.callTool({
            name,
            arguments: { ref, ...(name === 'read_document' ? { key: 'plan' } : {}) },
          });
          expect(response).toMatchObject({
            isError: true,
            content: [{ type: 'text', text: expect.stringContaining('Input validation error') }],
          });
          // Only scope loading may read an issue; invalid refs never reach the query helper.
          expect(lookup).toHaveBeenCalledExactlyOnceWith({ _id: new ObjectId(epic.id) });
        }
      } finally {
        await client.close();
      }
    },
  );

  it.each(['connect', 'handleRequest'] as const)(
    'ends hijacked requests when %s fails and handles close rejections',
    async (operation) => {
      const { token } = await startRunFor(epic.id);
      if (operation === 'connect') {
        vi.spyOn(McpServer.prototype, 'connect').mockRejectedValueOnce(new Error('connect failed'));
      } else {
        vi.spyOn(StreamableHTTPServerTransport.prototype, 'handleRequest').mockRejectedValueOnce(
          new Error('request failed'),
        );
      }
      const transportClose = vi
        .spyOn(StreamableHTTPServerTransport.prototype, 'close')
        .mockRejectedValueOnce(new Error('transport close failed'));
      const serverClose = vi
        .spyOn(McpServer.prototype, 'close')
        .mockRejectedValueOnce(new Error('server close failed'));
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${token}` },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: 'internal_server_error' });
      expect(transportClose).toHaveBeenCalledTimes(1);
      expect(serverClose).toHaveBeenCalledTimes(1);
    },
  );
});
