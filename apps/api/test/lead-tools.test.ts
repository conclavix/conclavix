import { ObjectId } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerLeadTools } from '../src/modules/agent-api/org-tools.js';
import { loadScope } from '../src/modules/agent-api/scope.js';
import { loadPosition } from '../src/modules/org/position.js';
import { buildPrompt } from '../src/runner/prompt.js';
import { createTestContext, type TestContext } from './helpers.js';
import { callTool, connectAgent, startRunFor } from './mcp-helpers.js';
import { createFixture, type Fixture, issueRun } from './scheduler-helpers.js';

const LEAD_TOOLS = ['create_issue', 'get_project_board', 'list_projects'];

describe('lead planning tools and run prompt position', () => {
  let ctx: TestContext;
  let fx: Fixture;
  let baseUrl: string;
  let lead: { id: string };
  let cto: { id: string };
  let dev: { id: string };
  let other: { id: string; key: string };

  const setLead = (agentId: string) =>
    ctx.request({ method: 'PUT', url: '/api/org/lead', payload: { agentId } });

  beforeEach(async () => {
    ctx = await createTestContext();
    baseUrl = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    fx = await createFixture(ctx);
    lead = await fx.agent({ name: 'CEO', role: 'ceo' });
    cto = await fx.agent({ name: 'CTO', role: 'cto', reportsTo: lead.id });
    dev = await fx.agent({ name: 'Dev', role: 'engineer', reportsTo: cto.id });
    expect((await setLead(lead.id)).statusCode).toBe(200);
    other = (
      await ctx.request({
        method: 'POST',
        url: '/api/projects',
        payload: { key: 'OTHER', name: 'Other', description: 'Second project', autoPlan: false },
      })
    ).json();
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('serves planning tools to the lead only and plans across projects', async () => {
    const leadIssue = await fx.issue({ title: 'Plan', assigneeAgentId: lead.id });
    const ctoIssue = await fx.issue({ title: 'Architecture', assigneeAgentId: cto.id });
    const leadRun = await startRunFor(ctx, fx, leadIssue.id);
    const ctoRun = await startRunFor(ctx, fx, ctoIssue.id);
    const leadClient = await connectAgent(baseUrl, leadRun.token);
    const ctoClient = await connectAgent(baseUrl, ctoRun.token);

    const leadTools = (await leadClient.listTools()).tools.map((tool) => tool.name);
    const ctoTools = (await ctoClient.listTools()).tools.map((tool) => tool.name);
    expect(leadTools).toEqual(expect.arrayContaining(LEAD_TOOLS));
    expect(ctoTools.filter((name) => LEAD_TOOLS.includes(name))).toEqual([]);
    const hidden = await callTool(ctoClient, 'list_projects');
    expect(hidden.isError).toBe(true);

    const projects = await callTool(leadClient, 'list_projects');
    expect(projects.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'OTHER', description: 'Second project', openIssues: {} }),
      ]),
    );

    const created = await callTool(leadClient, 'create_issue', {
      projectKey: 'OTHER',
      title: 'Design the data model',
      priority: 'high',
      assigneeAgentId: cto.id,
    });
    expect(created.isError).toBe(false);
    expect(created.data).toMatchObject({
      key: 'OTHER-1',
      parentId: null,
      projectId: other.id,
      priority: 'high',
      assigneeAgentId: cto.id,
      delegatedBy: lead.id,
    });
    expect(
      await ctx.database.collections.wakes.countDocuments({
        agentId: new ObjectId(cto.id),
        issueId: new ObjectId(created.data['id'] as string),
        processedAt: null,
      }),
    ).toBe(1);

    const twoHops = await callTool(leadClient, 'create_issue', {
      projectKey: 'OTHER',
      title: 'Too deep',
      assigneeAgentId: dev.id,
    });
    expect(twoHops.isError).toBe(true);
    const missing = await callTool(leadClient, 'create_issue', { projectKey: 'NOPE', title: 'x' });
    expect(missing.isError).toBe(true);

    const board = await callTool(leadClient, 'get_project_board', { projectKey: 'OTHER' });
    expect(board.data).toMatchObject({
      project: { key: 'OTHER' },
      issues: [{ key: 'OTHER-1', assignee: 'CTO', status: 'todo' }],
      truncated: false,
    });

    const peer = await fx.agent({ name: 'Successor' });
    expect((await setLead(peer.id)).statusCode).toBe(200);
    const revoked = await callTool(leadClient, 'list_projects');
    expect(revoked.isError).toBe(true);
    expect(revoked.data.error).toMatch(/list_projects not found/);

    await leadClient.close();
    await ctoClient.close();
  });

  it('checks the lead again inside every lead tool call', async () => {
    const issue = await fx.issue({ title: 'Architecture', assigneeAgentId: cto.id });
    const { run } = await startRunFor(ctx, fx, issue.id);
    const scope = await loadScope(ctx.database, issueRun(run));
    expect(scope.isLead).toBe(false);
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: never) => handlers.set(name, handler),
    } as unknown as McpServer;
    registerLeadTools(server, ctx.database, scope);
    const result = (await handlers.get('list_projects')?.({})) as {
      isError: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/only the lead agent/);
  });

  it('tells each agent its position, the delegation rule and unread notifications', async () => {
    const issue = await fx.issue({ title: 'Architecture', assigneeAgentId: cto.id });
    await ctx.database.collections.notifications.insertOne({
      _id: new ObjectId(),
      agentId: new ObjectId(cto.id),
      issueId: new ObjectId(issue.id),
      kind: 'delegation_closed',
      text: 'S1-7 "Login" is done (worked on by Dev).',
      createdAt: new Date(),
      readAt: null,
    });
    const { collections } = ctx.database;
    const ctoDoc = await collections.agents.findOne({ _id: new ObjectId(cto.id) });
    const leadDoc = await collections.agents.findOne({ _id: new ObjectId(lead.id) });
    const issueDoc = await collections.issues.findOne({ _id: new ObjectId(issue.id) });
    if (!ctoDoc || !leadDoc || !issueDoc) throw new Error('fixture missing');

    const ctoPrompt = buildPrompt(
      ctoDoc,
      issueDoc,
      'assigned',
      await loadPosition(ctx.database, ctoDoc),
    );
    expect(ctoPrompt).toContain('- You are not the lead.');
    expect(ctoPrompt).toContain('- Can delegate to you: CEO (ceo).');
    expect(ctoPrompt).toContain('- You can delegate to: Dev (engineer).');
    expect(ctoPrompt).toContain('- You report to: CEO (ceo).');
    expect(ctoPrompt).toContain('- S1-7 "Login" is done (worked on by Dev).');

    const leadPrompt = buildPrompt(
      leadDoc,
      issueDoc,
      'assigned',
      await loadPosition(ctx.database, leadDoc),
    );
    expect(leadPrompt).toContain('- You are the lead.');
    expect(leadPrompt).toContain('- Can delegate to you: nobody; your work comes from the board.');
    expect(leadPrompt).toContain('- You can delegate to: CTO (cto).');
    expect(leadPrompt).not.toContain('Unread notifications');
    expect(leadPrompt).not.toContain('repo:');

    const codingPrompt = buildPrompt(
      ctoDoc,
      issueDoc,
      'assigned',
      await loadPosition(ctx.database, ctoDoc),
      { code: true },
    );
    expect(codingPrompt).toContain('docs/screenshots/<module>/');
    expect(codingPrompt).toContain('](repo:docs/screenshots/<module>/<name>.png)');
  });
});
