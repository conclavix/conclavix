import { ObjectId, type ClientSession } from 'mongodb';
import type { AgentNotification, NotificationKind } from '@conclavix/core';
import type { Collections, NotificationDoc } from '../../db.js';

/** Notifications kept per agent; older ones are dropped when new ones arrive. */
export const MAX_NOTIFICATIONS_PER_AGENT = 200;

export const toNotification = (doc: NotificationDoc): AgentNotification => ({
  id: doc._id.toHexString(),
  issueId: doc.issueId.toHexString(),
  kind: doc.kind,
  text: doc.text,
  createdAt: doc.createdAt,
  readAt: doc.readAt,
});

/** Record a notification for an agent. It never wakes the agent; its next run sees it. */
export async function notify(
  collections: Collections,
  input: { agentId: ObjectId; issueId: ObjectId; kind: NotificationKind; text: string },
  session: ClientSession,
): Promise<void> {
  await collections.notifications.insertOne(
    { _id: new ObjectId(), ...input, createdAt: new Date(), readAt: null },
    { session },
  );
  const oldestKept = await collections.notifications
    .find({ agentId: input.agentId }, { projection: { _id: 1 }, session })
    .sort({ _id: -1 })
    .skip(MAX_NOTIFICATIONS_PER_AGENT - 1)
    .limit(1)
    .next();
  if (oldestKept) {
    await collections.notifications.deleteMany(
      { agentId: input.agentId, _id: { $lt: oldestKept._id } },
      { session },
    );
  }
}

/** An agent's notifications, newest first. */
export async function listNotifications(
  collections: Collections,
  agentId: ObjectId,
  options: { unreadOnly: boolean; limit: number },
): Promise<AgentNotification[]> {
  const docs = await collections.notifications
    .find({ agentId, ...(options.unreadOnly ? { readAt: null } : {}) })
    .sort({ _id: -1 })
    .limit(options.limit)
    .toArray();
  return docs.map(toNotification);
}

/** Mark the given notifications of an agent read, or all of them when no ids are given. */
export async function markNotificationsRead(
  collections: Collections,
  agentId: ObjectId,
  ids: ObjectId[] | undefined,
): Promise<number> {
  const result = await collections.notifications.updateMany(
    { agentId, readAt: null, ...(ids ? { _id: { $in: ids } } : {}) },
    { $set: { readAt: new Date() } },
  );
  return result.modifiedCount;
}
