import { ObjectId } from 'mongodb';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toStreamEvent } from '../src/modules/stream/events.js';
import { createTestContext, type TestContext } from './helpers.js';
import { callTool, connectAgent, startRunFor } from './mcp-helpers.js';
import { createFixture, type Fixture } from './scheduler-helpers.js';

describe('board decisions', () => {
  let ctx: TestContext;
  let fx: Fixture;
  let baseUrl: string;
  let agent: { id: string };
  let issue: { id: string; key: string };

  const issueDoc = () => ctx.database.collections.issues.findOne({ _id: new ObjectId(issue.id) });
  const decisions = async (status = 'open') =>
    (await ctx.request({ method: 'GET', url: `/api/decisions?status=${status}` })).json();
  const openCount = async () =>
    (await ctx.request({ method: 'GET', url: '/api/decisions/count' })).json().open as number;
  const commentWakes = () =>
    ctx.database.collections.wakes.countDocuments({
      issueId: new ObjectId(issue.id),
      reason: 'comment',
      processedAt: null,
    });

  const ask = async (args: Record<string, unknown>): Promise<Client> => {
    const { token } = await startRunFor(ctx, fx, issue.id);
    const client = await connectAgent(baseUrl, token);
    const result = await callTool(client, 'request_board_decision', args);
    expect(result.isError).toBe(false);
    return client;
  };

  beforeEach(async () => {
    ctx = await createTestContext();
    baseUrl = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    fx = await createFixture(ctx);
    agent = await fx.agent({ name: 'Planner' });
    issue = await fx.issue({ title: 'Pick a database', status: 'todo', assigneeAgentId: agent.id });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await ctx.close();
  });

  it('sets in_review and awaitingBoard, posts the question and lists it for the board', async () => {
    const client = await ask({ question: 'Postgres or Mongo?', options: ['Postgres', 'Mongo'] });
    const doc = await issueDoc();
    expect(doc?.status).toBe('in_review');
    expect(doc?.awaitingBoard).toMatchObject({
      question: 'Postgres or Mongo?',
      options: ['Postgres', 'Mongo'],
    });
    expect(doc?.awaitingBoard?.askedBy.toHexString()).toBe(agent.id);

    const own = await callTool(client, 'get_issue');
    const thread = own.data['comments'] as { author: { type: string }; body: string }[];
    expect(thread.at(-1)).toMatchObject({ author: { type: 'agent' } });
    expect(thread.at(-1)?.body).toContain('Postgres or Mongo?');
    expect(own.data['issue']).toMatchObject({
      awaitingBoard: { question: 'Postgres or Mongo?', askedBy: agent.id },
    });
    await client.close();

    const listed = await decisions();
    expect(listed.total).toBe(1);
    expect(listed.items[0]).toMatchObject({
      status: 'open',
      question: 'Postgres or Mongo?',
      options: ['Postgres', 'Mongo'],
      askedBy: { agentId: agent.id, name: 'Planner' },
      issue: { key: issue.key, status: 'in_review' },
      project: { id: fx.projectId },
    });
    expect(await openCount()).toBe(1);
  });

  it('rejects duplicate options and replaces an open question when asked again', async () => {
    const { token } = await startRunFor(ctx, fx, issue.id);
    const client = await connectAgent(baseUrl, token);
    const duplicate = await callTool(client, 'request_board_decision', {
      question: 'Which?',
      options: ['A', 'A'],
    });
    expect(duplicate.isError).toBe(true);
    await callTool(client, 'request_board_decision', { question: 'First?' });
    await callTool(client, 'request_board_decision', { question: 'Second?' });
    await client.close();
    const listed = await decisions();
    expect(listed.items.map((item: { question: string }) => item.question)).toEqual(['Second?']);
    expect(await ctx.database.collections.decisions.countDocuments({ status: 'superseded' })).toBe(
      1,
    );
  });

  it('clears awaitingBoard when the board comments, moves to in_progress and wakes the agent', async () => {
    (await ask({ question: 'Ship on Friday?' })).close();
    const comment = await ctx.request({
      method: 'POST',
      url: `/api/issues/${issue.key}/comments`,
      payload: { body: 'Yes, ship it.' },
    });
    expect(comment.statusCode).toBe(201);
    const doc = await issueDoc();
    expect(doc?.status).toBe('in_progress');
    expect(doc?.awaitingBoard).toBeNull();
    expect(await commentWakes()).toBe(1);
    expect(await openCount()).toBe(0);
    const decided = await decisions('decided');
    expect(decided.items[0]).toMatchObject({
      status: 'answered',
      answer: 'Yes, ship it.',
      decidedBy: { type: 'board' },
    });
  });

  it('does not let an agent comment answer the question', async () => {
    const client = await ask({ question: 'Ship on Friday?' });
    expect((await callTool(client, 'add_comment', { body: 'still waiting' })).isError).toBe(false);
    await client.close();
    const doc = await issueDoc();
    expect(doc?.awaitingBoard).not.toBeNull();
    expect(doc?.status).toBe('in_review');
    expect(await openCount()).toBe(1);
  });

  it('answers with an option through the decisions API', async () => {
    (await ask({ question: 'Which region?', options: ['eu', 'us'] })).close();
    const [open] = (await decisions()).items as { id: string }[];
    const wrong = await ctx.request({
      method: 'POST',
      url: `/api/decisions/${open?.id}/answer`,
      payload: { option: 'asia' },
    });
    expect(wrong.statusCode).toBe(422);
    const empty = await ctx.request({
      method: 'POST',
      url: `/api/decisions/${open?.id}/answer`,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);

    const answered = await ctx.request({
      method: 'POST',
      url: `/api/decisions/${open?.id}/answer`,
      payload: { option: 'eu', body: 'Data must stay in the EU.' },
    });
    expect(answered.statusCode).toBe(200);
    expect(answered.json()).toMatchObject({
      status: 'answered',
      answer: '**Decision:** eu\n\nData must stay in the EU.',
    });
    expect((await issueDoc())?.status).toBe('in_progress');
    expect(await commentWakes()).toBe(1);

    const again = await ctx.request({
      method: 'POST',
      url: `/api/decisions/${open?.id}/answer`,
      payload: { option: 'us' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('rejects an answer that read the decision as open before another answer settled it', async () => {
    (await ask({ question: 'Which region?', options: ['eu', 'us'] })).close();
    const [open] = (await decisions()).items as { id: string }[];
    const stale = await ctx.database.collections.decisions.findOne({ _id: new ObjectId(open?.id) });
    const first = await ctx.request({
      method: 'POST',
      url: `/api/decisions/${open?.id}/answer`,
      payload: { option: 'eu' },
    });
    expect(first.statusCode).toBe(200);
    // The second request passed its open check before the first one committed.
    vi.spyOn(ctx.database.collections.decisions, 'findOne').mockResolvedValueOnce(stale);
    const second = await ctx.request({
      method: 'POST',
      url: `/api/decisions/${open?.id}/answer`,
      payload: { option: 'us' },
    });
    expect(second.statusCode).toBe(409);
    expect(
      await ctx.database.collections.comments.countDocuments({
        issueId: new ObjectId(issue.id),
        body: { $regex: '^\\*\\*Decision:' },
      }),
    ).toBe(1);
    expect(await commentWakes()).toBe(1);
  });

  it('does not settle a newer question with an answer meant for the superseded one', async () => {
    const { token } = await startRunFor(ctx, fx, issue.id);
    const client = await connectAgent(baseUrl, token);
    await callTool(client, 'request_board_decision', { question: 'Region?', options: ['eu'] });
    const [first] = (await decisions()).items as { id: string }[];
    const stale = await ctx.database.collections.decisions.findOne({
      _id: new ObjectId(first?.id),
    });
    await callTool(client, 'request_board_decision', { question: 'Size?', options: ['S', 'L'] });
    await client.close();
    vi.spyOn(ctx.database.collections.decisions, 'findOne').mockResolvedValueOnce(stale);
    const answered = await ctx.request({
      method: 'POST',
      url: `/api/decisions/${first?.id}/answer`,
      payload: { option: 'eu' },
    });
    expect(answered.statusCode).toBe(409);
    const doc = await issueDoc();
    expect(doc?.status).toBe('in_review');
    expect(doc?.awaitingBoard?.question).toBe('Size?');
    expect((await decisions()).items).toMatchObject([{ question: 'Size?', status: 'open' }]);
  });

  it('lets the board dismiss a question, which wakes the agent', async () => {
    (await ask({ question: 'Rename the product?' })).close();
    const [open] = (await decisions()).items as { id: string }[];
    const dismissed = await ctx.request({
      method: 'POST',
      url: `/api/decisions/${open?.id}/dismiss`,
      payload: { reason: 'Out of scope.' },
    });
    expect(dismissed.statusCode).toBe(200);
    expect(dismissed.json()).toMatchObject({ status: 'dismissed' });
    const doc = await issueDoc();
    expect(doc?.awaitingBoard).toBeNull();
    expect(doc?.status).toBe('in_progress');
    expect(await commentWakes()).toBe(1);
    const thread = await ctx.database.collections.comments
      .find({ issueId: new ObjectId(issue.id) })
      .sort({ _id: -1 })
      .limit(1)
      .toArray();
    expect(thread[0]?.body).toContain('Out of scope.');
  });

  it('withdraws the question when the issue leaves in_review without an answer', async () => {
    (await ask({ question: 'Need a designer?' })).close();
    const patched = await ctx.request({
      method: 'PATCH',
      url: `/api/issues/${issue.key}`,
      payload: { status: 'in_progress' },
    });
    expect(patched.json().awaitingBoard).toBeNull();
    expect(await openCount()).toBe(0);
    expect((await decisions('decided')).items[0]).toMatchObject({ status: 'withdrawn' });
  });

  it('keeps the question while in_review stays, and plain in_review sets no question', async () => {
    const { token } = await startRunFor(ctx, fx, issue.id);
    const client = await connectAgent(baseUrl, token);
    await callTool(client, 'set_status', { status: 'in_review' });
    expect((await issueDoc())?.awaitingBoard ?? null).toBeNull();
    expect(await openCount()).toBe(0);
    await callTool(client, 'request_board_decision', { question: 'Go?' });
    await callTool(client, 'set_status', { status: 'in_review' });
    expect((await issueDoc())?.awaitingBoard).not.toBeNull();
    await client.close();
  });

  it('settles the question on a board comment even when nobody is assigned', async () => {
    (await ask({ question: 'Who owns this?' })).close();
    await fx.patch(issue.key, { assigneeAgentId: null });
    await ctx.request({
      method: 'POST',
      url: `/api/issues/${issue.key}/comments`,
      payload: { body: 'The platform team.' },
    });
    const doc = await issueDoc();
    expect(doc?.awaitingBoard).toBeNull();
    expect(doc?.status).toBe('in_review');
    expect(await openCount()).toBe(0);
  });

  it('answers 404 for unknown or malformed decision ids', async () => {
    const missing = await ctx.request({
      method: 'POST',
      url: `/api/decisions/${new ObjectId().toHexString()}/answer`,
      payload: { body: 'x' },
    });
    expect(missing.statusCode).toBe(404);
    const malformed = await ctx.request({
      method: 'POST',
      url: '/api/decisions/nope/dismiss',
      payload: {},
    });
    expect(malformed.statusCode).toBe(404);
  });

  it('streams decision changes and the awaitingBoard field of issues', () => {
    const decisionId = new ObjectId();
    const decision = toStreamEvent({
      operationType: 'insert',
      ns: { db: 'x', coll: 'decisions' },
      documentKey: { _id: decisionId },
      fullDocument: {
        _id: decisionId,
        issueId: new ObjectId(),
        projectId: new ObjectId(),
        status: 'open',
        question: 'secret context',
      },
    } as never);
    expect(decision).toMatchObject({ type: 'decision', data: { status: 'open' } });
    expect(decision?.data).not.toHaveProperty('question');
    const since = new Date();
    const askedBy = new ObjectId();
    const issueEvent = toStreamEvent({
      operationType: 'update',
      ns: { db: 'x', coll: 'issues' },
      documentKey: { _id: new ObjectId() },
      fullDocument: {
        _id: new ObjectId(),
        awaitingBoard: { decisionId, since, question: 'Q', options: [], askedBy },
      },
    } as never);
    expect(issueEvent?.data['awaitingBoard']).toEqual({
      decisionId: decisionId.toHexString(),
      since,
      question: 'Q',
      options: [],
      askedBy: askedBy.toHexString(),
    });
  });
});
