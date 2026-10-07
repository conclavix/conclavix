import { ObjectId } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';
import { asBrowser, createUser, signIn } from './auth-helpers.js';
import { createFixture, type Fixture } from './scheduler-helpers.js';
import { chatTurn, createLeadChat, startChatRun } from './chat-helpers.js';

describe('board chats with the lead', () => {
  let ctx: TestContext;
  let fx: Fixture;

  beforeEach(async () => {
    ctx = await createTestContext({ settingsDefaults: { mfaPolicy: 'optional' } });
    fx = await createFixture(ctx);
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('needs a lead to start a chat and binds the chat to it', async () => {
    await fx.agent({ name: 'A', role: 'ceo' });
    await fx.agent({ name: 'B', role: 'cto' });
    const refused = await ctx.request({
      method: 'POST',
      url: '/api/chats',
      payload: { title: 'Plan' },
    });
    expect(refused.statusCode).toBe(409);
    const { lead, chatId } = await createLeadChat(ctx, fx);
    const read = await ctx.request({ method: 'GET', url: `/api/chats/${chatId}` });
    expect(read.json()).toMatchObject({
      chat: { id: chatId, status: 'open', leadAgentId: lead.id, plan: null, approval: null },
      messages: [],
    });
    const list = await ctx.request({ method: 'GET', url: '/api/chats' });
    expect(list.json().items.map((chat: { id: string }) => chat.id)).toEqual([chatId]);
  });

  it('turns a board message into one chat run of the lead, one turn at a time', async () => {
    const { lead, chatId } = await createLeadChat(ctx, fx);
    const posted = await ctx.request({
      method: 'POST',
      url: `/api/chats/${chatId}/messages`,
      payload: { content: 'We want a web shop.' },
    });
    expect(posted.statusCode).toBe(202);
    expect(posted.json().chat.pendingTurn).toMatchObject({ reason: 'chat' });
    const again = await ctx.request({
      method: 'POST',
      url: `/api/chats/${chatId}/messages`,
      payload: { content: 'And a blog.' },
    });
    expect(again.statusCode).toBe(409);

    const run = await startChatRun(ctx, fx, chatId);
    expect(run).toMatchObject({ issueId: null, reason: 'chat', status: 'queued' });
    expect(run.agentId.toHexString()).toBe(lead.id);
    expect(fx.dispatcher.runs.map((item) => item._id.toHexString())).toEqual([
      run._id.toHexString(),
    ]);
    const chat = (await ctx.request({ method: 'GET', url: `/api/chats/${chatId}` })).json().chat;
    expect(chat).toMatchObject({ activeRunId: run._id.toHexString(), pendingTurn: null });
    const listed = await ctx.request({ method: 'GET', url: `/api/runs?chatId=${chatId}` });
    expect(listed.json().items).toEqual([
      expect.objectContaining({ kind: 'chat', chatId, issueId: null }),
    ]);
    expect(await fx.scheduler.processChatTurns()).toEqual({ run: 0, drop: 0, defer: 0 });
  });

  it('never pauses the lead for chat runs and leaves a reply when the runner lost one', async () => {
    const { lead, chatId } = await createLeadChat(ctx, fx);
    for (let turn = 0; turn < 8; turn += 1) {
      const run = await chatTurn(ctx, fx, chatId, `message ${turn}`);
      await fx.scheduler.startRun(run._id, 60_000);
      await fx.scheduler.finishRun(run._id, { status: 'succeeded', costUsd: 0.01 });
      const finished = await ctx.database.collections.runs.findOne({ _id: run._id });
      expect(finished?.madeProgress).toBeNull();
    }
    const agent = await ctx.request({ method: 'GET', url: `/api/agents/${lead.id}` });
    expect(agent.json().status).toBe('active');
    const { messages } = (await ctx.request({ method: 'GET', url: `/api/chats/${chatId}` })).json();
    const replies = messages.filter((message: { role: string }) => message.role === 'agent');
    expect(replies).toHaveLength(8);
    expect(replies[0]).toMatchObject({ content: '', error: 'the run ended without a reply' });
  });

  it('refuses turns for a paused lead and holds them at the daily cost limit', async () => {
    const { lead, chatId } = await createLeadChat(ctx, fx);
    await ctx.request({
      method: 'PATCH',
      url: `/api/agents/${lead.id}`,
      payload: { status: 'paused' },
    });
    const paused = await ctx.request({
      method: 'POST',
      url: `/api/chats/${chatId}/messages`,
      payload: { content: 'Hello?' },
    });
    expect(paused.statusCode).toBe(409);
    expect(paused.json().message).toMatch(/paused/);
    await ctx.request({
      method: 'PATCH',
      url: `/api/agents/${lead.id}`,
      payload: { status: 'active' },
    });

    const posted = await ctx.request({
      method: 'POST',
      url: `/api/chats/${chatId}/messages`,
      payload: { content: 'Hello' },
    });
    expect(posted.statusCode).toBe(202);
    // Spend the whole daily budget on another run between the post and the scheduler tick.
    await ctx.database.collections.runs.insertOne({
      _id: new ObjectId(),
      agentId: new ObjectId(lead.id),
      issueId: null,
      chatId: new ObjectId(),
      reason: 'chat',
      status: 'succeeded',
      costUsd: 1000,
      maxCostPerRunUsd: 1,
      overBudget: true,
      progressAtStart: 0,
      madeProgress: null,
      error: null,
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      tokenHash: null,
      tokenExpiresAt: null,
    });
    expect(await fx.scheduler.processChatTurns()).toEqual({ run: 0, drop: 0, defer: 1 });
    const chat = (await ctx.request({ method: 'GET', url: `/api/chats/${chatId}` })).json().chat;
    expect(chat.pendingTurn).toMatchObject({ deferReason: 'daily_cost_limit' });
    expect(chat.pendingTurn.notBefore).not.toBeNull();
    const more = await ctx.request({
      method: 'POST',
      url: `/api/chats/${chatId}/messages`,
      payload: { content: 'Still there?' },
    });
    expect(more.statusCode).toBe(409);
  });

  it('drops a pending turn when the lead was paused meanwhile', async () => {
    const { lead, chatId } = await createLeadChat(ctx, fx);
    await ctx.request({
      method: 'POST',
      url: `/api/chats/${chatId}/messages`,
      payload: { content: 'Hello' },
    });
    await ctx.request({
      method: 'PATCH',
      url: `/api/agents/${lead.id}`,
      payload: { status: 'paused' },
    });
    expect(await fx.scheduler.processChatTurns()).toEqual({ run: 0, drop: 1, defer: 0 });
    const chat = (await ctx.request({ method: 'GET', url: `/api/chats/${chatId}` })).json().chat;
    expect(chat).toMatchObject({ pendingTurn: null, activeRunId: null });
    expect(chat.lastError).toMatch(/paused/);
  });

  // Four users with password hashing and sign-in: slower than the default timeout on a busy host.
  it('lets every role read chats and only admins and owners talk and approve', async () => {
    const { chatId } = await createLeadChat(ctx, fx);
    for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
      await createUser(ctx, `${role}@example.com`, role);
      const { cookie } = await signIn(ctx, `${role}@example.com`);
      const as = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
        asBrowser(ctx, cookie, { method, url, ...(payload ? { payload } : {}) });
      expect((await as('GET', '/api/chats')).statusCode).toBe(200);
      expect((await as('GET', `/api/chats/${chatId}`)).statusCode).toBe(200);
      expect((await as('GET', `/api/chats/${chatId}/plan/revisions`)).statusCode).toBe(200);
      const allowed = role === 'owner' || role === 'admin';
      const created = await as('POST', '/api/chats', { title: `by ${role}` });
      expect(created.statusCode).toBe(allowed ? 201 : 403);
      const target = allowed ? created.json().id : chatId;
      const posted = await as('POST', `/api/chats/${target}/messages`, { content: 'Hi' });
      expect(posted.statusCode).toBe(allowed ? 202 : 403);
      if (allowed) {
        expect(posted.json().message.author).toMatchObject({ type: 'user' });
      }
      const approve = await as('POST', `/api/chats/${chatId}/approve`, { planRevision: 1 });
      // Allowed roles reach the domain check: there is no plan yet.
      expect(approve.statusCode).toBe(allowed ? 409 : 403);
      expect((await as('PATCH', `/api/chats/${chatId}`, { title: 'x' })).statusCode).toBe(
        allowed ? 200 : 403,
      );
    }
  }, 30_000);

  it('archives a chat and then refuses messages', async () => {
    const { chatId } = await createLeadChat(ctx, fx);
    const run = await chatTurn(ctx, fx, chatId);
    const busy = await ctx.request({
      method: 'PATCH',
      url: `/api/chats/${chatId}`,
      payload: { status: 'archived' },
    });
    expect(busy.statusCode).toBe(409);
    await fx.scheduler.startRun(run._id, 60_000);
    await fx.scheduler.finishRun(run._id, { status: 'succeeded', costUsd: 0 });
    const archived = await ctx.request({
      method: 'PATCH',
      url: `/api/chats/${chatId}`,
      payload: { status: 'archived' },
    });
    expect(archived.json().status).toBe('archived');
    const posted = await ctx.request({
      method: 'POST',
      url: `/api/chats/${chatId}/messages`,
      payload: { content: 'Hello' },
    });
    expect(posted.statusCode).toBe(409);
  });
});
