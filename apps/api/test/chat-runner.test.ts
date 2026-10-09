import { ObjectId } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_LIMITS } from '@conclavix/core';
import type { AgentDoc, ChatDoc, ChatMessageDoc, ProjectDoc } from '../src/db.js';
import { writeChatPlan } from '../src/modules/chats/agent-actions.js';
import type { Adapter, AdapterRunInput } from '../src/runner/adapters/types.js';
import { buildChatPrompt, chatHistory } from '../src/runner/chat-prompt.js';
import { RunWorker } from '../src/runner/run-worker.js';
import { createTestContext, type TestContext } from './helpers.js';
import { createFixture, type Fixture } from './scheduler-helpers.js';
import { chatTurn, createLeadChat } from './chat-helpers.js';
import { tempRoot } from './workspace-helpers.js';

const message = (role: 'board' | 'agent', content: string, at = new Date()): ChatMessageDoc => ({
  _id: new ObjectId(),
  chatId: new ObjectId(),
  role,
  author: role === 'board' ? { type: 'board' } : { type: 'agent', agentId: 'a'.repeat(24) },
  content,
  runId: null,
  error: null,
  createdAt: at,
});

const agent = { name: 'Mr. Green', title: 'CEO', role: 'ceo' } as AgentDoc;

const chat = (overrides: Partial<ChatDoc> = {}): ChatDoc => ({
  _id: new ObjectId(),
  title: 'Plan the shop',
  status: 'open',
  leadAgentId: new ObjectId(),
  projectId: null,
  createdBy: { type: 'board' },
  plan: null,
  approval: null,
  createdProjectId: null,
  createdIssueId: null,
  activeRunId: null,
  pendingTurn: null,
  lastError: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('chat run history and prompt', () => {
  it('keeps the newest messages within the message and character limits', () => {
    const many = Array.from({ length: CHAT_LIMITS.historyMessages + 5 }, (_, index) =>
      message(index % 2 === 0 ? 'board' : 'agent', `message ${index}`),
    );
    const history = chatHistory(many);
    expect(history.omitted).toBe(5);
    expect(history.text).not.toContain('message 4\n');
    expect(history.text).toContain(`message ${many.length - 1}`);
    // The runner loads only the newest messages and passes the total.
    expect(chatHistory(many.slice(-10), 100).omitted).toBe(90);

    const long = [
      message('board', 'x'.repeat(CHAT_LIMITS.historyMessageChars)),
      message('agent', 'y'.repeat(CHAT_LIMITS.historyMessageChars)),
      ...Array.from({ length: 8 }, () => message('board', 'z'.repeat(CHAT_LIMITS.historyChars))),
    ];
    const capped = chatHistory(long);
    expect(capped.text.length).toBeLessThanOrEqual(
      CHAT_LIMITS.historyChars + CHAT_LIMITS.historyMessageChars,
    );
    expect(capped.text).toContain('characters cut');
    expect(capped.omitted).toBeGreaterThan(0);
  });

  it('describes the discussion rules, the plan and the conversation', () => {
    const prompt = buildChatPrompt({
      agent,
      chat: chat({
        plan: { revision: 3, markdown: '# Goal\nA shop', runId: null, updatedAt: new Date() },
      }),
      messages: [message('board', 'We need a shop'), message('agent', 'Which products?')],
      project: null,
      code: false,
    });
    expect(prompt).toContain('You are Mr. Green, CEO (role: ceo)');
    expect(prompt).toContain('write_chat_plan');
    expect(prompt).toContain('Do not create projects or issues during the discussion');
    expect(prompt).toContain('revision 3');
    expect(prompt).toContain('# Goal\nA shop');
    expect(prompt.indexOf('We need a shop')).toBeLessThan(prompt.indexOf('Which products?'));
    expect(prompt).not.toContain('read-only code tools');
    const about = buildChatPrompt({
      agent,
      chat: chat(),
      messages: [message('board', 'Extend it')],
      project: { _id: new ObjectId(), key: 'SHOP', name: 'Shop' } as ProjectDoc,
      code: true,
    });
    expect(about).toContain('existing project SHOP "Shop"');
    expect(about).toContain('If your tools include the read-only code tools');
  });

  it('tells the lead to carry out an approved plan once', () => {
    const prompt = buildChatPrompt({
      agent,
      chat: chat({
        status: 'approved',
        approval: { userId: null, at: new Date(), planRevision: 2 },
      }),
      messages: [message('board', 'Plan revision 2 approved.')],
      project: null,
      code: false,
    });
    expect(prompt).toContain('The board approved plan revision 2');
    expect(prompt).toContain('create_project');
    expect(prompt).toContain('create_planning_issue');
  });
});

describe('chat runs in the runner', () => {
  let ctx: TestContext;
  let fx: Fixture;
  let root: ReturnType<typeof tempRoot>;

  beforeEach(async () => {
    ctx = await createTestContext();
    fx = await createFixture(ctx);
    root = tempRoot('cvx-chat-runner-');
  });

  afterEach(async () => {
    await ctx.close();
    root.cleanup();
  });

  const workerWith = (adapter: Adapter) =>
    new RunWorker(ctx.database, fx.scheduler, {
      workspacesRoot: root.dir,
      mcpUrl: 'http://127.0.0.1:9/mcp',
      timeoutMs: 10_000,
      adapters: { claude_cli: adapter },
    });

  it('runs the lead with the chat prompt and stores its redacted reply', async () => {
    const { chatId } = await createLeadChat(ctx, fx);
    const run = await chatTurn(ctx, fx, chatId, 'We want a shop for tea.');
    const inputs: AdapterRunInput[] = [];
    const adapter: Adapter = {
      run: vi.fn(async (input: AdapterRunInput) => {
        inputs.push(input);
        return {
          status: 'succeeded' as const,
          costUsd: 0.02,
          summary: 'Which teas? token ghp_FAKEfakeFAKEfakeFAKEfake0123456789',
        };
      }),
    };
    await workerWith(adapter).process(run._id);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.issue).toBeNull();
    expect(inputs[0]?.prompt).toContain('We want a shop for tea.');
    expect(inputs[0]?.workspace).toContain('_chat');

    const read = (await ctx.request({ method: 'GET', url: `/api/chats/${chatId}` })).json();
    expect(read.chat.activeRunId).toBeNull();
    const reply = read.messages.at(-1);
    expect(reply).toMatchObject({ role: 'agent', runId: run._id.toHexString(), error: null });
    expect(reply.content).toContain('Which teas?');
    expect(reply.content).not.toContain('ghp_FAKE');
    const done = await ctx.database.collections.runs.findOne({ _id: run._id });
    expect(done).toMatchObject({ status: 'succeeded', costUsd: 0.02, madeProgress: null });
  });

  it('records the error of a failed chat run as the reply', async () => {
    const { chatId } = await createLeadChat(ctx, fx);
    const run = await chatTurn(ctx, fx, chatId);
    const adapter: Adapter = {
      run: async () => ({ status: 'failed', costUsd: 0, error: 'claude exited with code 1' }),
    };
    await workerWith(adapter).process(run._id);
    const read = (await ctx.request({ method: 'GET', url: `/api/chats/${chatId}` })).json();
    expect(read.messages.at(-1)).toMatchObject({
      role: 'agent',
      content: '',
      error: 'claude exited with code 1',
    });
  });

  it('lets only the run answering the chat write its plan', async () => {
    const { chatId } = await createLeadChat(ctx, fx);
    const run = await chatTurn(ctx, fx, chatId);
    const other = { ...run, _id: new ObjectId() };
    await expect(writeChatPlan(ctx.database, other, 'x')).rejects.toThrow(/answering the chat/);
    await expect(writeChatPlan(ctx.database, run, '# Plan')).resolves.toEqual({ revision: 1 });
  });
});
