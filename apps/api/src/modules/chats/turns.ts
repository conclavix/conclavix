import { ObjectId, type ClientSession } from 'mongodb';
import type { AgentDoc, ChatDoc, ChatRunDoc, Collections } from '../../db.js';
import { storedLeadId } from '../org/lead.js';
import { costToday, startOfNextUtcDay } from '../scheduler/gates.js';

/**
 * What the scheduler does with a pending chat turn. Chat runs are started by the board, so only
 * the hard limits apply: the agent must exist, be the lead and be active, and the daily cost limit
 * holds the turn until the next UTC day. The idle-run limit, its backoff and the daily run cap
 * per issue do not apply, and chat runs never pause the lead.
 */
export type ChatTurnGate =
  | { kind: 'run'; agent: AgentDoc }
  | { kind: 'drop'; error: string }
  | { kind: 'defer_until'; until: Date };

export async function chatTurnGate(
  collections: Collections,
  chat: ChatDoc,
  now: Date,
  session: ClientSession,
): Promise<ChatTurnGate> {
  if (chat.status === 'archived') {
    return { kind: 'drop', error: 'the chat was archived' };
  }
  const agent = await collections.agents.findOne({ _id: chat.leadAgentId }, { session });
  if (!agent) {
    return { kind: 'drop', error: 'the lead agent of this chat no longer exists' };
  }
  const leadId = await storedLeadId(collections, session);
  if (!leadId?.equals(agent._id)) {
    return { kind: 'drop', error: `${agent.name} is no longer the lead` };
  }
  if (agent.status !== 'active') {
    return { kind: 'drop', error: `${agent.name} was paused before it could answer` };
  }
  if ((await costToday(collections, agent, now, session)) >= agent.limits.maxCostPerDayUsd) {
    return { kind: 'defer_until', until: startOfNextUtcDay(now) };
  }
  return { kind: 'run', agent };
}

/** A queued chat run for the chat's pending turn. */
export function newChatRun(chat: ChatDoc, agent: AgentDoc, now: Date): ChatRunDoc {
  return {
    _id: new ObjectId(),
    agentId: agent._id,
    issueId: null,
    chatId: chat._id,
    reason: chat.pendingTurn?.reason ?? 'chat',
    status: 'queued',
    costUsd: 0,
    maxCostPerRunUsd: agent.limits.maxCostPerRunUsd,
    overBudget: false,
    progressAtStart: 0,
    madeProgress: null,
    error: null,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    tokenHash: null,
    tokenExpiresAt: null,
  };
}

/** Text shown for a reply whose run ended without one. */
export const NO_REPLY = '';

/**
 * Store the lead's reply to the chat; the runner calls this with the run's (redacted) final text
 * before it finishes the run. A second call for the same run changes nothing.
 */
export async function recordChatReply(
  collections: Collections,
  run: ChatRunDoc,
  content: string,
  error: string | null,
  now = new Date(),
): Promise<void> {
  await collections.chatMessages.updateOne(
    { runId: run._id },
    {
      $setOnInsert: {
        _id: new ObjectId(),
        chatId: run.chatId,
        role: 'agent',
        author: { type: 'agent', agentId: run.agentId.toHexString() },
        content,
        runId: run._id,
        error,
        createdAt: now,
      },
    },
    { upsert: true },
  );
}

/**
 * Free the chat for the next turn once its run finished, and make sure the run left a reply in
 * the chat (a run the runner lost has none; the board then sees the error).
 */
export async function releaseChatRun(
  collections: Collections,
  run: ChatRunDoc,
  error: string | null,
  now: Date,
  session: ClientSession,
): Promise<void> {
  await collections.chats.updateOne(
    { _id: run.chatId, activeRunId: run._id },
    { $set: { activeRunId: null, updatedAt: now } },
    { session },
  );
  await collections.chatMessages.updateOne(
    { runId: run._id },
    {
      $setOnInsert: {
        _id: new ObjectId(),
        chatId: run.chatId,
        role: 'agent',
        author: { type: 'agent', agentId: run.agentId.toHexString() },
        content: NO_REPLY,
        runId: run._id,
        error: error ?? 'the run ended without a reply',
        createdAt: now,
      },
    },
    { upsert: true, session },
  );
}
