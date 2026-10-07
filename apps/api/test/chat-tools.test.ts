import { join } from 'node:path';
import { ObjectId } from 'mongodb';
import { Workspace } from '../src/modules/workspace/service.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';
import { callTool, connectAgent } from './mcp-helpers.js';
import { createFixture, type Fixture } from './scheduler-helpers.js';
import { chatTurn, createLeadChat, startChatRun } from './chat-helpers.js';
import { tempRoot } from './workspace-helpers.js';

const CHAT_TOOLS = [
  'create_planning_issue',
  'create_project',
  'get_project_board',
  'list_projects',
  'memory_save',
  'memory_search',
  'write_chat_plan',
];

describe('chat run tools and the approval gate', () => {
  let ctx: TestContext;
  let fx: Fixture;
  let baseUrl: string;
  let root: ReturnType<typeof tempRoot>;

  beforeEach(async () => {
    root = tempRoot('cvx-chat-tools-');
    // With a workspace the code tools exist; chats get them only for a referenced project.
    ctx = await createTestContext({ workspace: new Workspace(join(root.dir, 'ws')) });
    baseUrl = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    fx = await createFixture(ctx);
  });

  afterEach(async () => {
    await ctx.close();
    root.cleanup();
  });

  const getChat = async (chatId: string) =>
    (await ctx.request({ method: 'GET', url: `/api/chats/${chatId}` })).json();

  /** Start the queued chat run and connect to the agent API with its token. */
  const connectRun = async (runId: ObjectId) => {
    const { token } = await fx.scheduler.startRun(runId, 60_000);
    return connectAgent(baseUrl, token);
  };

  it('serves only the chat tools and refuses creation before the approval', async () => {
    const { chatId } = await createLeadChat(ctx, fx);
    const run = await chatTurn(ctx, fx, chatId);
    const client = await connectRun(run._id);
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual(CHAT_TOOLS);

    expect((await callTool(client, 'list_projects')).isError).toBe(false);
    const project = await callTool(client, 'create_project', { key: 'SHOP', name: 'Shop' });
    expect(project).toMatchObject({ isError: true });
    expect(project.data.error).toMatch(/refused until the board approves/);
    const issue = await callTool(client, 'create_planning_issue', {
      projectId: fx.projectId,
      title: 'Plan',
    });
    expect(issue.isError).toBe(true);
    expect(await ctx.database.collections.projects.countDocuments({ key: 'SHOP' })).toBe(0);

    const first = await callTool(client, 'write_chat_plan', { markdown: '# Goal\nA shop' });
    const second = await callTool(client, 'write_chat_plan', { markdown: '# Goal\nA web shop' });
    expect([first.data, second.data]).toEqual([{ revision: 1 }, { revision: 2 }]);
    expect((await getChat(chatId)).chat.plan).toMatchObject({
      revision: 2,
      markdown: '# Goal\nA web shop',
      runId: run._id.toHexString(),
    });
    const revisions = await ctx.request({
      method: 'GET',
      url: `/api/chats/${chatId}/plan/revisions`,
    });
    expect(revisions.json().items.map((item: { revision: number }) => item.revision)).toEqual([
      2, 1,
    ]);
    const memory = await callTool(client, 'memory_save', {
      scope: 'project',
      title: 'Decision',
      body: 'x',
    });
    expect(memory.isError).toBe(true);
    await client.close();
  });

  it('creates the project and the planning issue once after the approval', async () => {
    const { lead, chatId } = await createLeadChat(ctx, fx);
    const discussion = await chatTurn(ctx, fx, chatId);
    const discussing = await connectRun(discussion._id);
    await callTool(discussing, 'write_chat_plan', { markdown: '# Plan\nBuild the shop' });
    // Approving while the lead still answers is refused: the plan may still change.
    const early = await ctx.request({
      method: 'POST',
      url: `/api/chats/${chatId}/approve`,
      payload: { planRevision: 1 },
    });
    expect(early.statusCode).toBe(409);
    await fx.scheduler.finishRun(discussion._id, { status: 'succeeded', costUsd: 0 });
    // A finished run's token is gone: it cannot act on the chat any more.
    await expect(callTool(discussing, 'write_chat_plan', { markdown: 'late' })).rejects.toThrow(
      /unauthorized/,
    );
    await discussing.close();

    const wrong = await ctx.request({
      method: 'POST',
      url: `/api/chats/${chatId}/approve`,
      payload: { planRevision: 2 },
    });
    expect(wrong.statusCode).toBe(409);
    const approved = await ctx.request({
      method: 'POST',
      url: `/api/chats/${chatId}/approve`,
      payload: { planRevision: 1 },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      status: 'approved',
      approval: { planRevision: 1, userId: null },
      pendingTurn: { reason: 'plan_approved' },
    });
    const twice = await ctx.request({
      method: 'POST',
      url: `/api/chats/${chatId}/approve`,
      payload: { planRevision: 1 },
    });
    expect(twice.statusCode).toBe(409);

    const run = await startChatRun(ctx, fx, chatId);
    expect(run.reason).toBe('plan_approved');
    const client = await connectRun(run._id);
    const frozen = await callTool(client, 'write_chat_plan', { markdown: 'changed' });
    expect(frozen.isError).toBe(true);
    expect(frozen.data.error).toMatch(/frozen/);

    const project = await callTool(client, 'create_project', {
      key: 'SHOP',
      name: 'Shop',
      description: 'The web shop',
    });
    expect(project).toMatchObject({ isError: false, data: { key: 'SHOP' } });
    const again = await callTool(client, 'create_project', { key: 'SHOP2', name: 'Shop 2' });
    expect(again.isError).toBe(true);
    expect(again.data.error).toMatch(/once/);

    const elsewhere = await callTool(client, 'create_planning_issue', {
      projectId: fx.projectId,
      title: 'Plan',
    });
    expect(elsewhere.isError).toBe(true);
    const issue = await callTool(client, 'create_planning_issue', {
      projectId: project.data['id'],
      title: 'Plan the web shop',
      description: 'Approved plan: build the shop',
    });
    expect(issue).toMatchObject({
      isError: false,
      data: { key: 'SHOP-1', assigneeAgentId: lead.id, labels: ['planning'], status: 'todo' },
    });
    const second = await callTool(client, 'create_planning_issue', {
      projectId: project.data['id'],
      title: 'Plan again',
    });
    expect(second.isError).toBe(true);
    await client.close();

    const wake = await ctx.database.collections.wakes.findOne({
      issueId: new ObjectId(issue.data['id'] as string),
      processedAt: null,
    });
    expect(wake?.agentId.toHexString()).toBe(lead.id);
    expect((await getChat(chatId)).chat.created).toEqual({
      projectId: project.data['id'],
      projectKey: 'SHOP',
      issueId: issue.data['id'],
      issueKey: 'SHOP-1',
    });
    const audit = await ctx.database.collections.audit
      .find({ action: { $regex: '^chat\\.' } })
      .sort({ _id: 1 })
      .toArray();
    expect(audit.map((entry) => entry.action)).toEqual([
      'chat.plan_approved',
      'chat.project_created',
      'chat.issue_created',
    ]);
    expect(audit[2]?.details).toMatchObject({ chatId, issueKey: 'SHOP-1', planRevision: 1 });

    await fx.scheduler.finishRun(run._id, { status: 'succeeded', costUsd: 0 });
    const done = await ctx.request({
      method: 'POST',
      url: `/api/chats/${chatId}/messages`,
      payload: { content: 'Thanks' },
    });
    expect(done.statusCode).toBe(409);
  });

  it("refuses the creation tools once the run's agent is no longer the lead", async () => {
    const { chatId } = await createLeadChat(ctx, fx);
    const discussion = await chatTurn(ctx, fx, chatId);
    const discussing = await connectRun(discussion._id);
    await callTool(discussing, 'write_chat_plan', { markdown: '# Plan' });
    await discussing.close();
    await fx.scheduler.finishRun(discussion._id, { status: 'succeeded', costUsd: 0 });
    await ctx.request({
      method: 'POST',
      url: `/api/chats/${chatId}/approve`,
      payload: { planRevision: 1 },
    });
    const run = await startChatRun(ctx, fx, chatId);
    const client = await connectRun(run._id);
    const successor = await fx.agent({ name: 'Successor', role: 'ceo' });
    await ctx.request({ method: 'PUT', url: '/api/org/lead', payload: { agentId: successor.id } });
    const project = await callTool(client, 'create_project', { key: 'LATE', name: 'Late' });
    expect(project.isError).toBe(true);
    expect(project.data.error).toMatch(/no longer the lead/);
    expect(await ctx.database.collections.projects.countDocuments({ key: 'LATE' })).toBe(0);
    await client.close();
  });

  it('plans a referenced project without creating a new one', async () => {
    const { chatId } = await createLeadChat(ctx, fx, { projectId: fx.projectId });
    const discussion = await chatTurn(ctx, fx, chatId);
    const discussing = await connectRun(discussion._id);
    const names = (await discussing.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['read_file', 'list_branches']));
    await callTool(discussing, 'write_chat_plan', { markdown: 'Extend the project' });
    await discussing.close();
    await fx.scheduler.finishRun(discussion._id, { status: 'succeeded', costUsd: 0 });
    await ctx.request({
      method: 'POST',
      url: `/api/chats/${chatId}/approve`,
      payload: { planRevision: 1 },
    });
    const run = await startChatRun(ctx, fx, chatId);
    const client = await connectRun(run._id);
    const issue = await callTool(client, 'create_planning_issue', {
      projectId: fx.projectId,
      title: 'Plan the extension',
    });
    expect(issue.isError).toBe(false);
    await client.close();
  });
});
