import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOARD_TOKEN, createTestContext, type TestContext } from './helpers.js';

interface Received {
  event: string;
  data: Record<string, unknown>;
}

async function openStream(
  baseUrl: string,
  token: string,
): Promise<{
  status: number;
  next(predicate: (item: Received) => boolean, timeoutMs?: number): Promise<Received>;
  close(): void;
}> {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/stream`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  const received: Received[] = [];
  const waiters: (() => void)[] = [];
  if (response.body) {
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += value;
          let index;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const event = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.+)$/m.exec(block)?.[1];
            if (event && data) {
              received.push({ event, data: JSON.parse(data) as Record<string, unknown> });
              waiters.splice(0).forEach((wake) => wake());
            }
          }
        }
      } catch {
        return;
      }
    })();
  }
  return {
    status: response.status,
    close: () => controller.abort(),
    next: async (predicate, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = received.find(predicate);
        if (found) return found;
        if (Date.now() > deadline) throw new Error('timed out waiting for stream event');
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 100);
        });
      }
    },
  };
}

describe('board event stream', () => {
  let ctx: TestContext;
  let baseUrl: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    baseUrl = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('rejects clients without the board token', async () => {
    const stream = await openStream(baseUrl, 'wrong');
    expect(stream.status).toBe(401);
    stream.close();
  });

  it('pushes agents, issues, comments, runs and run log lines as they happen', async () => {
    const stream = await openStream(baseUrl, BOARD_TOKEN);
    expect(stream.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const project = (
      await ctx.request({
        method: 'POST',
        url: '/api/projects',
        payload: { key: 'LIVE', name: 'Live' },
      })
    ).json();
    const agent = (
      await ctx.request({
        method: 'POST',
        url: '/api/agents',
        payload: {
          name: 'Streamer',
          role: 'engineer',
          adapter: { type: 'claude_cli' },
          instructions: 'secret instructions',
        },
      })
    ).json();
    const issue = (
      await ctx.request({
        method: 'POST',
        url: '/api/issues',
        payload: { projectId: project.id, title: 'Watch me', assigneeAgentId: agent.id },
      })
    ).json();
    await ctx.request({
      method: 'POST',
      url: `/api/issues/${issue.key}/comments`,
      payload: { body: 'hello stream' },
    });

    const agentEvent = await stream.next(
      (item) => item.event === 'agent' && item.data['id'] === agent.id,
    );
    expect(agentEvent.data).toEqual({
      id: agent.id,
      name: 'Streamer',
      status: 'active',
      avatarUrl: null,
    });
    expect(JSON.stringify(agentEvent.data)).not.toContain('secret instructions');

    const issueEvent = await stream.next(
      (item) => item.event === 'issue' && item.data['key'] === issue.key,
    );
    expect(issueEvent.data).toMatchObject({
      projectId: project.id,
      title: 'Watch me',
      status: 'todo',
      priority: 'medium',
      columnId: 'todo',
      assigneeAgentId: agent.id,
    });

    const commentEvent = await stream.next((item) => item.event === 'comment');
    expect(commentEvent.data).toMatchObject({ issueId: issue.id, body: 'hello stream' });

    const runId = new ObjectId();
    await ctx.database.collections.runEvents.insertOne({
      _id: new ObjectId(),
      runId,
      seq: 1,
      type: 'tool_use',
      text: 'mcp__conclavix__get_issue {}',
      data: {
        kind: 'tool_use',
        toolUseId: 'toolu_1',
        name: 'mcp__conclavix__get_issue',
        input: '{}',
      },
      at: new Date(),
    });
    await ctx.database.collections.runs.insertOne({
      _id: runId,
      agentId: new ObjectId(agent.id),
      issueId: new ObjectId(issue.id),
      reason: 'manual',
      status: 'running',
      costUsd: 0,
      maxCostPerRunUsd: 1,
      overBudget: false,
      progressAtStart: 0,
      madeProgress: null,
      error: null,
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: null,
      tokenHash: 'never-sent',
      tokenExpiresAt: new Date(),
    });
    const runEvent = await stream.next(
      (item) => item.event === 'run' && item.data['id'] === runId.toHexString(),
    );
    expect(runEvent.data).toMatchObject({
      status: 'running',
      agentId: agent.id,
      issueId: issue.id,
    });
    expect(JSON.stringify(runEvent.data)).not.toContain('never-sent');

    const logEvent = await stream.next((item) => item.event === 'run_event');
    expect(logEvent.data).toMatchObject({
      runId: runId.toHexString(),
      seq: 1,
      type: 'tool_use',
      data: { kind: 'tool_use', toolUseId: 'toolu_1' },
    });
    stream.close();
  });

  it('serves several clients from one shared change stream', async () => {
    const a = await openStream(baseUrl, BOARD_TOKEN);
    const b = await openStream(baseUrl, BOARD_TOKEN);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await ctx.request({
      method: 'POST',
      url: '/api/projects',
      payload: { key: 'TWO', name: 'Two' },
    });
    await ctx.request({
      method: 'POST',
      url: '/api/agents',
      payload: { name: 'Shared', role: 'x', adapter: { type: 'claude_cli' } },
    });
    await a.next((item) => item.event === 'agent' && item.data['name'] === 'Shared');
    await b.next((item) => item.event === 'agent' && item.data['name'] === 'Shared');
    a.close();
    b.close();
  });

  it('streams link, layout and lead changes, including link deletion', async () => {
    const stream = await openStream(baseUrl, BOARD_TOKEN);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const create = (name: string) =>
      ctx.request({
        method: 'POST',
        url: '/api/agents',
        payload: { name, role: 'x', adapter: { type: 'claude_cli' } },
      });
    const a = (await create('Canvas A')).json();
    const b = (await create('Canvas B')).json();
    const link = (
      await ctx.request({
        method: 'POST',
        url: '/api/agent-links',
        payload: { from: a.id, to: b.id, type: 'delegates' },
      })
    ).json();
    await ctx.request({
      method: 'PUT',
      url: '/api/org/layout',
      payload: { positions: [{ agentId: a.id, x: 5, y: 6 }] },
    });
    await ctx.request({ method: 'PUT', url: '/api/org/lead', payload: { agentId: a.id } });
    await ctx.request({ method: 'DELETE', url: `/api/agent-links/${link.id}` });
    const report = (
      await ctx.request({
        method: 'POST',
        url: '/api/agent-links',
        payload: { from: b.id, to: a.id, type: 'reports' },
      })
    ).json();
    await ctx.request({
      method: 'PATCH',
      url: `/api/agent-links/${report.id}`,
      payload: { wakeOnReport: true },
    });

    const created = await stream.next(
      (item) => item.event === 'agent_link' && item.data['id'] === link.id && !item.data['deleted'],
    );
    expect(created.data).toEqual({
      id: link.id,
      from: a.id,
      to: b.id,
      type: 'delegates',
      wakeOnReport: false,
    });
    const toggled = await stream.next(
      (item) => item.event === 'agent_link' && item.data['wakeOnReport'] === true,
    );
    expect(toggled.data).toEqual({
      id: report.id,
      from: b.id,
      to: a.id,
      type: 'reports',
      wakeOnReport: true,
    });
    const layout = await stream.next((item) => item.event === 'org_layout');
    expect(layout.data).toEqual({ agentId: a.id, x: 5, y: 6 });
    const lead = await stream.next(
      (item) => item.event === 'org' && item.data['leadAgentId'] === a.id,
    );
    expect(lead.data).toEqual({ leadAgentId: a.id });
    const deleted = await stream.next(
      (item) => item.event === 'agent_link' && item.data['deleted'] === true,
    );
    expect(deleted.data).toEqual({ id: link.id, deleted: true });
    stream.close();
  });
});
