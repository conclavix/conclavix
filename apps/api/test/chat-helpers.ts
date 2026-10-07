import { ObjectId } from 'mongodb';
import type { ChatRunDoc } from '../src/db.js';
import type { TestContext } from './helpers.js';
import type { Fixture } from './scheduler-helpers.js';

export interface ChatFixture {
  lead: { id: string; name: string };
  chatId: string;
}

/** A lead agent set as the organisation's lead and an open chat with it. */
export async function createLeadChat(
  ctx: TestContext,
  fx: Fixture,
  payload: Record<string, unknown> = {},
): Promise<ChatFixture> {
  const lead = (await fx.agent({
    name: `Mr. Green ${new ObjectId().toHexString()}`,
    role: 'ceo',
  })) as {
    id: string;
    name: string;
  };
  const set = await ctx.request({
    method: 'PUT',
    url: '/api/org/lead',
    payload: { agentId: lead.id },
  });
  if (set.statusCode !== 200) throw new Error(`setting the lead failed: ${set.body}`);
  const chat = await ctx.request({
    method: 'POST',
    url: '/api/chats',
    payload: { title: 'Plan the shop', ...payload },
  });
  if (chat.statusCode !== 201) throw new Error(`creating the chat failed: ${chat.body}`);
  return { lead, chatId: chat.json().id as string };
}

/** Post a board message and let the scheduler start the chat run; returns the queued run. */
export async function chatTurn(
  ctx: TestContext,
  fx: Fixture,
  chatId: string,
  content = 'We want a small web shop.',
): Promise<ChatRunDoc> {
  const posted = await ctx.request({
    method: 'POST',
    url: `/api/chats/${chatId}/messages`,
    payload: { content },
  });
  if (posted.statusCode !== 202) throw new Error(`posting failed: ${posted.body}`);
  return startChatRun(ctx, fx, chatId);
}

/** Process the chat's pending turn into a queued chat run. */
export async function startChatRun(
  ctx: TestContext,
  fx: Fixture,
  chatId: string,
): Promise<ChatRunDoc> {
  await fx.scheduler.processChatTurns();
  const run = await ctx.database.collections.runs.findOne({
    chatId: new ObjectId(chatId),
    status: 'queued',
  });
  if (!run?.chatId) throw new Error('expected a queued chat run');
  return { ...run, issueId: null, chatId: run.chatId };
}
