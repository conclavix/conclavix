import { ObjectId } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';
import { callTool, connectAgent, startRunFor } from './mcp-helpers.js';
import { createFixture, type Fixture } from './scheduler-helpers.js';

describe('delegation along agent links', () => {
  let ctx: TestContext;
  let fx: Fixture;
  let baseUrl: string;
  let manager: { id: string };
  let engineer: { id: string };
  let grand: { id: string };
  let peer: { id: string };
  let observer: { id: string };
  let epic: { id: string; key: string };

  const link = async (from: string, to: string, type: 'delegates' | 'reports') => {
    const response = await ctx.request({
      method: 'POST',
      url: '/api/agent-links',
      payload: { from, to, type },
    });
    expect(response.statusCode).toBe(201);
  };
  const pendingWakesFor = (agentId: string) =>
    ctx.database.collections.wakes
      .find({ agentId: new ObjectId(agentId), processedAt: null })
      .toArray();
  const notificationsFor = (agentId: string) =>
    ctx.database.collections.notifications.find({ agentId: new ObjectId(agentId) }).toArray();

  beforeEach(async () => {
    ctx = await createTestContext();
    baseUrl = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    fx = await createFixture(ctx);
    manager = await fx.agent({ name: 'Manager', role: 'manager' });
    engineer = await fx.agent({ name: 'Engineer' });
    grand = await fx.agent({ name: 'Grand' });
    peer = await fx.agent({ name: 'Peer' });
    observer = await fx.agent({ name: 'Observer', role: 'qa' });
    await link(manager.id, engineer.id, 'delegates');
    await link(engineer.id, grand.id, 'delegates');
    await link(engineer.id, manager.id, 'reports');
    await link(engineer.id, observer.id, 'reports');
    epic = await fx.issue({ title: 'Ship the shop', assigneeAgentId: manager.id });
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('lets an agent delegate only to itself and its direct delegation links', async () => {
    const { token } = await startRunFor(ctx, fx, epic.id);
    const client = await connectAgent(baseUrl, token);

    const team = await callTool(client, 'list_team');
    expect(team.data).toEqual({
      canDelegateTo: [expect.objectContaining({ id: engineer.id, name: 'Engineer' })],
      notInThisProject: [],
      reportsTo: [],
    });

    const direct = await callTool(client, 'create_subissue', {
      title: 'Build the API',
      assigneeAgentId: engineer.id,
    });
    expect(direct.isError).toBe(false);
    expect(direct.data).toMatchObject({ assigneeAgentId: engineer.id, delegatedBy: manager.id });
    const self = await callTool(client, 'create_subissue', {
      title: 'Write the plan',
      assigneeAgentId: manager.id,
    });
    expect(self.data).toMatchObject({ assigneeAgentId: manager.id, delegatedBy: null });

    for (const target of [grand.id, peer.id, observer.id]) {
      const denied = await callTool(client, 'create_subissue', {
        title: 'Not yours',
        assigneeAgentId: target,
      });
      expect(denied.isError).toBe(true);
      expect(denied.data.error).toMatch(/delegate to agents you have a link to/);
    }
    await client.close();

    const engineerTask = await fx.issue({ title: 'Engineer task', assigneeAgentId: engineer.id });
    const engineerRun = await startRunFor(ctx, fx, engineerTask.id);
    const engineerClient = await connectAgent(baseUrl, engineerRun.token);
    const engineerTeam = await callTool(engineerClient, 'list_team');
    expect(engineerTeam.data['reportsTo']).toEqual([
      expect.objectContaining({ id: manager.id }),
      expect.objectContaining({ id: observer.id }),
    ]);
    const reverse = await callTool(engineerClient, 'create_subissue', {
      title: 'Boss, do this',
      assigneeAgentId: manager.id,
    });
    expect(reverse.isError).toBe(true);
    await engineerClient.close();
  });

  it('re-reads the links on every call, so a link removed mid-run stops delegation', async () => {
    const { token } = await startRunFor(ctx, fx, epic.id);
    const client = await connectAgent(baseUrl, token);
    await ctx.database.collections.agentLinks.deleteMany({ from: new ObjectId(manager.id) });
    const denied = await callTool(client, 'create_subissue', {
      title: 'Too late',
      assigneeAgentId: engineer.id,
    });
    expect(denied.isError).toBe(true);
    await client.close();
  });

  it('wakes the delegator on its issue and only notifies other report targets', async () => {
    const { run, token } = await startRunFor(ctx, fx, epic.id);
    const client = await connectAgent(baseUrl, token);
    const child = (
      await callTool(client, 'create_subissue', { title: 'Build it', assigneeAgentId: engineer.id })
    ).data as { key: string };
    await client.close();
    await fx.scheduler.finishRun(run._id, { status: 'succeeded', costUsd: 0 });
    await fx.scheduler.processPendingWakes();

    expect(await fx.patch(child.key, { status: 'done' })).toMatchObject({ status: 'done' });

    const managerWakes = await pendingWakesFor(manager.id);
    expect(managerWakes).toEqual([
      expect.objectContaining({ issueId: new ObjectId(epic.id), reason: 'delegation_closed' }),
    ]);
    expect(await notificationsFor(manager.id)).toHaveLength(0);
    expect(await pendingWakesFor(observer.id)).toHaveLength(0);
    const [note] = await notificationsFor(observer.id);
    expect(note?.text).toMatch(/is done \(worked on by Engineer\)/);

    const before = fx.dispatcher.runs.length;
    await fx.scheduler.processPendingWakes();
    expect(fx.dispatcher.runs.slice(before).map((item) => item.agentId.toHexString())).toEqual([
      manager.id,
    ]);
    expect(
      await ctx.database.collections.wakes.countDocuments({ agentId: new ObjectId(observer.id) }),
    ).toBe(0);
    expect(
      await ctx.database.collections.runs.countDocuments({ agentId: new ObjectId(observer.id) }),
    ).toBe(0);
  });

  it('resumes a delegator that waits in_review and wakes it instead of notifying', async () => {
    const { run, token } = await startRunFor(ctx, fx, epic.id);
    const client = await connectAgent(baseUrl, token);
    const child = (
      await callTool(client, 'create_subissue', { title: 'Build it', assigneeAgentId: engineer.id })
    ).data as { key: string };
    await callTool(client, 'set_status', { status: 'in_review' });
    await client.close();
    await fx.scheduler.finishRun(run._id, { status: 'succeeded', costUsd: 0 });

    await fx.patch(child.key, { status: 'cancelled' });
    expect(
      await ctx.database.collections.issues.findOne({ _id: new ObjectId(epic.id) }),
    ).toMatchObject({ status: 'in_progress', columnId: 'in_progress' });
    expect(await pendingWakesFor(manager.id)).toEqual([
      expect.objectContaining({ issueId: new ObjectId(epic.id), reason: 'subissue_closed' }),
    ]);
    expect(await notificationsFor(manager.id)).toHaveLength(0);
  });

  it('notifies the delegator instead when its issue is no longer actionable', async () => {
    const { run, token } = await startRunFor(ctx, fx, epic.id);
    const client = await connectAgent(baseUrl, token);
    const child = (
      await callTool(client, 'create_subissue', { title: 'Build it', assigneeAgentId: engineer.id })
    ).data as { key: string };
    await client.close();
    await fx.scheduler.finishRun(run._id, { status: 'succeeded', costUsd: 0 });
    await fx.patch(epic.key, { status: 'backlog' });

    await fx.patch(child.key, { status: 'cancelled' });
    expect(await pendingWakesFor(manager.id)).toHaveLength(0);
    const [note] = await notificationsFor(manager.id);
    expect(note?.text).toMatch(/is cancelled/);
  });

  it('shows notifications to the next run and lets the agent mark them read', async () => {
    await ctx.database.collections.notifications.insertOne({
      _id: new ObjectId(),
      agentId: new ObjectId(observer.id),
      issueId: new ObjectId(epic.id),
      kind: 'delegation_closed',
      text: 'S1-9 "Something" is done.',
      createdAt: new Date(),
      readAt: null,
    });
    const task = await fx.issue({ title: 'Review', assigneeAgentId: observer.id });
    const { token } = await startRunFor(ctx, fx, task.id);
    const client = await connectAgent(baseUrl, token);
    const unread = await callTool(client, 'list_notifications');
    expect(unread.data).toEqual([expect.objectContaining({ text: 'S1-9 "Something" is done.' })]);
    expect((await callTool(client, 'mark_notifications_read')).data).toEqual({ marked: 1 });
    expect((await callTool(client, 'list_notifications')).data).toEqual([]);
    await client.close();
  });
});
