import pino from 'pino';
import type { ChatDoc, Database, RunDoc } from '../../db.js';
import type { RunDispatcher } from '../scheduler/scheduler.js';
import { chatTurnGate, newChatRun } from './turns.js';

const log = pino({ name: 'scheduler' });

export type ChatTurnCounts = Record<'run' | 'drop' | 'defer', number>;

/**
 * Turn pending chat turns (a board message, an approved plan) into chat runs of the lead. Only
 * one run per chat at a time; a turn waiting for the daily cost limit stays pending until the
 * next UTC day, and a turn the lead cannot take any more (paused, replaced, deleted) is dropped
 * with the reason shown in the chat.
 */
export async function processChatTurns(
  database: Database,
  dispatcher: RunDispatcher,
  batchSize: number,
  failDispatch: (run: RunDoc, error: unknown) => Promise<void>,
  now = new Date(),
): Promise<ChatTurnCounts> {
  const counts = { run: 0, drop: 0, defer: 0 };
  const pending = await database.collections.chats
    .find({
      pendingTurn: { $type: 'object' },
      activeRunId: null,
      'pendingTurn.notBefore': { $not: { $gt: now } },
    })
    .sort({ 'pendingTurn.requestedAt': 1 })
    .limit(batchSize)
    .toArray();
  for (const chat of pending) {
    // One broken chat must not hold back the turns of the others.
    try {
      counts[await processChatTurn(database, dispatcher, failDispatch, chat, now)] += 1;
    } catch (error) {
      log.error({ err: error, chatId: chat._id.toHexString() }, 'chat turn failed');
    }
  }
  return counts;
}

async function processChatTurn(
  database: Database,
  dispatcher: RunDispatcher,
  failDispatch: (run: RunDoc, error: unknown) => Promise<void>,
  chat: ChatDoc,
  now: Date,
): Promise<'run' | 'drop' | 'defer'> {
  const outcome = await database.inTransaction(async (session) => {
    const current = await database.collections.chats.findOne(
      { _id: chat._id, pendingTurn: { $type: 'object' }, activeRunId: null },
      { session },
    );
    if (!current?.pendingTurn) {
      return { result: 'defer' as const, run: null };
    }
    const gate = await chatTurnGate(database.collections, current, now, session);
    if (gate.kind === 'drop') {
      await database.collections.chats.updateOne(
        { _id: current._id },
        { $set: { pendingTurn: null, lastError: gate.error, updatedAt: now } },
        { session },
      );
      return { result: 'drop' as const, run: null };
    }
    if (gate.kind === 'defer_until') {
      await database.collections.chats.updateOne(
        { _id: current._id },
        {
          $set: {
            'pendingTurn.notBefore': gate.until,
            'pendingTurn.deferReason': 'daily_cost_limit',
          },
        },
        { session },
      );
      return { result: 'defer' as const, run: null };
    }
    const run = newChatRun(current, gate.agent, now);
    await database.collections.runs.insertOne(run, { session });
    await database.collections.chats.updateOne(
      { _id: current._id },
      { $set: { activeRunId: run._id, pendingTurn: null, lastError: null, updatedAt: now } },
      { session },
    );
    return { result: 'run' as const, run };
  });
  if (outcome.run) {
    try {
      await dispatcher.dispatch(outcome.run);
    } catch (error) {
      await failDispatch(outcome.run, error);
    }
  }
  return outcome.result;
}
