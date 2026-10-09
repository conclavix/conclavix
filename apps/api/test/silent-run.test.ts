import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectId } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunDoc } from '../src/db.js';
import {
  escalateSilentRun,
  quoteFinalText,
  SILENT_RUN_TEXT_LIMIT,
} from '../src/modules/scheduler/silent-run.js';
import { requestWake } from '../src/modules/scheduler/wakes.js';
import { RunWorker } from '../src/runner/run-worker.js';
import { createTestContext, type TestContext } from './helpers.js';
import { callTool, connectAgent, startRunFor } from './mcp-helpers.js';
import { createFixture, type Fixture } from './scheduler-helpers.js';

const SILENT = /^Run [a-f0-9]{24} ended without a result/;

describe('silent run escalation', () => {
  let ctx: TestContext;
  let fx: Fixture;
  let baseUrl: string;
  let manager: { id: string };
  let engineer: { id: string };
  let epic: { id: string; key: string };

  const issueDoc = (id: string) =>
    ctx.database.collections.issues.findOne({ _id: new ObjectId(id) });
  const silentComments = async (id: string) =>
    (
      await ctx.database.collections.comments
        .find({ issueId: new ObjectId(id), 'author.type': 'system' })
        .toArray()
    ).filter((comment) => SILENT.test(comment.body));
  const wakesFor = (agentId: string) =>
    ctx.database.collections.wakes
      .find({ agentId: new ObjectId(agentId), processedAt: null })
      .toArray();
  const wakeAgain = (agentId: string, issueId: string) =>
    requestWake(ctx.database.collections, new ObjectId(agentId), new ObjectId(issueId), 'manual');
  /** One run of the issue's assignee that ends as given; `during` runs while it is running. */
  const runOnce = async (
    issueId: string,
    outcome: { status?: RunDoc['status']; finalText?: string } = {},
    during?: (run: RunDoc, token: string) => Promise<void>,
  ): Promise<RunDoc> => {
    const { run, token } = await startRunFor(ctx, fx, issueId);
    await during?.(run, token);
    const status = (outcome.status ?? 'succeeded') as 'succeeded';
    return fx.scheduler.finishRun(run._id, {
      status,
      costUsd: 0,
      finalText: outcome.finalText ?? 'I could not find mongod.',
    });
  };
  /** A sub-issue of the epic that the manager delegated to the engineer through the agent API. */
  const delegate = async (): Promise<{ id: string; key: string }> => {
    const { run, token } = await startRunFor(ctx, fx, epic.id);
    const client = await connectAgent(baseUrl, token);
    const child = (
      await callTool(client, 'create_subissue', {
        title: 'Run the tests',
        assigneeAgentId: engineer.id,
      })
    ).data as { id: string; key: string };
    await client.close();
    await fx.scheduler.finishRun(run._id, { status: 'succeeded', costUsd: 0 });
    return child;
  };

  beforeEach(async () => {
    ctx = await createTestContext();
    baseUrl = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    fx = await createFixture(ctx);
    const limits = { maxIdleRunsPerIssue: 10 };
    manager = await fx.agent({ name: 'Manager', role: 'manager', limits });
    engineer = await fx.agent({ name: 'Engineer', limits });
    const link = await ctx.request({
      method: 'POST',
      url: '/api/agent-links',
      payload: { from: manager.id, to: engineer.id, type: 'delegates' },
    });
    expect(link.statusCode).toBe(201);
    epic = await fx.issue({ title: 'Ship the shop', assigneeAgentId: manager.id });
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('comments and wakes the delegator on its issue, once per idle streak', async () => {
    const child = await delegate();
    const run = await runOnce(child.id);
    const [comment] = await silentComments(child.id);
    expect(comment?.body).toContain(`Run ${run._id.toHexString()} ended without a result`);
    expect(comment?.body).toContain('> I could not find mongod.');
    expect(comment?.body).toContain(
      `Escalated to Manager (who delegated it), woken on ${epic.key}`,
    );
    expect(await wakesFor(manager.id)).toEqual([
      expect.objectContaining({ issueId: new ObjectId(epic.id), reason: 'silent_run' }),
    ]);
    const notes = await ctx.database.collections.notifications
      .find({ agentId: new ObjectId(manager.id) })
      .toArray();
    expect(notes).toEqual([
      expect.objectContaining({ kind: 'silent_run', issueId: new ObjectId(child.id) }),
    ]);
    expect((await issueDoc(child.id))?.status).toBe('todo');

    await wakeAgain(engineer.id, child.id);
    await runOnce(child.id);
    expect(await silentComments(child.id)).toHaveLength(1);

    // The board moves the issue on (progress), which starts a new streak.
    await fx.patch(child.key, { status: 'in_progress' });
    await wakeAgain(engineer.id, child.id);
    await runOnce(child.id);
    expect(await silentComments(child.id)).toHaveLength(2);
  });

  it('starts a new streak after a run that made progress', async () => {
    const child = await delegate();
    await runOnce(child.id);
    await wakeAgain(engineer.id, child.id);
    await runOnce(child.id, {}, async () => {
      await ctx.database.collections.issues.updateOne(
        { _id: new ObjectId(child.id) },
        { $inc: { progress: 1 } },
      );
    });
    expect(await silentComments(child.id)).toHaveLength(1);
    await wakeAgain(engineer.id, child.id);
    await runOnce(child.id);
    expect(await silentComments(child.id)).toHaveLength(2);
  });

  it('leaves runs alone that commented, failed or timed out', async () => {
    const child = await delegate();
    await runOnce(child.id, {}, async (_run, token) => {
      const client = await connectAgent(baseUrl, token);
      const result = await callTool(client, 'add_comment', {
        issueId: child.id,
        body: 'Blocked: mongod is missing.',
      });
      expect(result.isError).toBe(false);
      await client.close();
    });
    for (const status of ['failed', 'timed_out', 'cancelled'] as const) {
      await wakeAgain(engineer.id, child.id);
      await runOnce(child.id, { status });
    }
    expect(await silentComments(child.id)).toHaveLength(0);
    expect(await wakesFor(manager.id)).toHaveLength(0);
  });

  it('hands back an in_review delegator issue and wakes the delegator there', async () => {
    const child = await delegate();
    await fx.patch(epic.key, { status: 'in_review' });
    await runOnce(child.id);
    expect((await issueDoc(epic.id))?.status).toBe('in_progress');
    expect(await wakesFor(manager.id)).toEqual([
      expect.objectContaining({ issueId: new ObjectId(epic.id), reason: 'silent_run' }),
    ]);
  });

  it('notifies a delegator that waits for a board decision and hands the issue to the board', async () => {
    const child = await delegate();
    await ctx.database.collections.issues.updateOne(
      { _id: new ObjectId(epic.id) },
      {
        $set: {
          status: 'in_review',
          awaitingBoard: {
            decisionId: new ObjectId(),
            since: new Date(),
            question: 'Which database?',
            options: [],
            askedBy: new ObjectId(manager.id),
          },
        },
      },
    );
    await runOnce(child.id);
    expect((await issueDoc(epic.id))?.status).toBe('in_review');
    expect(await wakesFor(manager.id)).toHaveLength(0);
    const [comment] = await silentComments(child.id);
    expect(comment?.body).toContain('Manager (who delegated it) was notified but cannot be woken');
    expect((await issueDoc(child.id))?.status).toBe('in_review');
    const notes = await ctx.database.collections.notifications
      .find({ agentId: new ObjectId(manager.id), kind: 'silent_run' })
      .toArray();
    expect(notes).toHaveLength(1);
  });

  it('moves an issue nobody delegated to in_review for the board', async () => {
    const task = await fx.issue({ title: 'Board task', assigneeAgentId: engineer.id });
    await runOnce(task.id, { finalText: '' });
    const issue = await issueDoc(task.id);
    expect(issue?.status).toBe('in_review');
    expect(issue?.silentRun?.agentId.toHexString()).toBe(engineer.id);
    const [comment] = await silentComments(task.id);
    expect(comment?.body).toContain('> (none)');
    expect(comment?.body).toContain('moved to in_review for the board');

    // The board's answer hands the issue back (progress), so the next silent run escalates again.
    const answer = await ctx.request({
      method: 'POST',
      url: `/api/issues/${task.key}/comments`,
      payload: { body: 'mongod is at the path in MONGOD_BIN' },
    });
    expect(answer.statusCode).toBe(201);
    expect((await issueDoc(task.id))?.status).toBe('in_progress');
    await runOnce(task.id);
    expect(await silentComments(task.id)).toHaveLength(2);
    expect((await issueDoc(task.id))?.status).toBe('in_review');
  });

  it('ignores chat runs and issues another run already took', async () => {
    // A chat run on an issue that would otherwise qualify: only the chat check stops it.
    const quiet = await fx.issue({ title: 'Quiet task', assigneeAgentId: manager.id });
    const chatRun = {
      _id: new ObjectId(),
      agentId: new ObjectId(manager.id),
      issueId: new ObjectId(quiet.id),
      chatId: new ObjectId(),
      status: 'succeeded',
      madeProgress: false,
      createdAt: new Date(),
      startedAt: new Date(),
    } as unknown as RunDoc;
    expect(await escalateSilentRun(ctx.database, chatRun, 'hi', new Date())).toEqual({
      escalated: false,
    });
    expect(
      await escalateSilentRun(ctx.database, { ...chatRun, chatId: null }, 'hi', new Date()),
    ).toMatchObject({ escalated: true });

    const task = await fx.issue({ title: 'Busy task', assigneeAgentId: engineer.id });
    const { run } = await startRunFor(ctx, fx, task.id);
    const other = new ObjectId();
    await ctx.database.collections.issues.updateOne(
      { _id: new ObjectId(task.id) },
      { $set: { checkoutRunId: other } },
    );
    await ctx.database.collections.runs.updateOne(
      { _id: run._id },
      { $set: { status: 'succeeded', madeProgress: false, finishedAt: new Date() } },
    );
    const finished = await ctx.database.collections.runs.findOne({ _id: run._id });
    if (!finished) throw new Error('expected the run');
    expect(await escalateSilentRun(ctx.database, finished, 'x', new Date())).toEqual({
      escalated: false,
    });
  });

  it('posts the final text redacted and truncated', async () => {
    const secret = `cvx-secret-${'k'.repeat(40)}`;
    const task = await fx.issue({ title: 'Redacted task', assigneeAgentId: engineer.id });
    await fx.scheduler.processPendingWakes();
    const workspaces = await mkdtemp(join(tmpdir(), 'cvx-silent-'));
    const worker = new RunWorker(ctx.database, fx.scheduler, {
      workspacesRoot: workspaces,
      mcpUrl: `${baseUrl}/mcp`,
      timeoutMs: 10_000,
      knownSecrets: [{ name: 'TEST_SECRET', value: secret }],
      adapters: {
        claude_cli: {
          run: async () => ({
            status: 'succeeded',
            costUsd: 0,
            summary: `Stuck, the key ${secret} did not help. ${'x'.repeat(1000)}`,
          }),
        },
      },
    });
    const run = await ctx.database.collections.runs.findOne({ issueId: new ObjectId(task.id) });
    if (!run) throw new Error('expected a queued run');
    await worker.process(run._id).finally(() => rm(workspaces, { recursive: true }));
    const [comment] = await silentComments(task.id);
    expect(comment?.body).not.toContain(secret);
    expect(comment?.body).toContain('Stuck, the key');
    expect(comment?.body.length).toBeLessThan(SILENT_RUN_TEXT_LIMIT + 400);
  });
});

describe('quoteFinalText', () => {
  it('cuts long text and marks empty text', () => {
    expect(quoteFinalText(null)).toBe('(none)');
    expect(quoteFinalText('  ')).toBe('(none)');
    expect(quoteFinalText('short')).toBe('short');
    const long = quoteFinalText('a'.repeat(SILENT_RUN_TEXT_LIMIT + 50));
    expect(long).toBe(`${'a'.repeat(SILENT_RUN_TEXT_LIMIT)}…`);
  });
});
