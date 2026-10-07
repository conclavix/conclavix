import type { Collections } from '../db.js';

const NOTIFICATION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** How long processed (run or skipped) wakes are kept before MongoDB expires them. */
export const PROCESSED_WAKE_RETENTION_SECONDS = 30 * 24 * 60 * 60;

const CASE_INSENSITIVE = { locale: 'en', strength: 2 } as const;

/** Indexes of board chats with the lead, their messages, plan revisions and chat runs. */
async function ensureChatIndexes(collections: Collections): Promise<void> {
  await collections.runs.createIndex(
    { chatId: 1, createdAt: -1 },
    { partialFilterExpression: { chatId: { $type: 'objectId' } } },
  );
  await collections.chats.createIndex({ status: 1, _id: -1 });
  await collections.chats.createIndex(
    { 'pendingTurn.requestedAt': 1 },
    { partialFilterExpression: { pendingTurn: { $type: 'object' } } },
  );
  // Messages are written by the API and the runner, so ids from one second do not sort by time.
  await collections.chatMessages.createIndex({ chatId: 1, createdAt: 1, _id: 1 });
  // One reply per chat run: the runner writes it, the scheduler only fills in a missing one.
  await collections.chatMessages.createIndex(
    { runId: 1 },
    { unique: true, partialFilterExpression: { runId: { $type: 'objectId' } } },
  );
  await collections.chatPlanRevisions.createIndex({ chatId: 1, revision: 1 }, { unique: true });
}

/** Create the unique and lookup indexes for all collections. */
export async function ensureIndexes(collections: Collections): Promise<void> {
  await collections.projects.createIndex({ key: 1 }, { unique: true });
  await collections.agents.createIndex({ name: 1 }, { unique: true, collation: CASE_INSENSITIVE });
  await collections.agents.createIndex({ reportsTo: 1 });
  await collections.issues.createIndex({ projectId: 1, number: 1 }, { unique: true });
  await collections.issues.createIndex({ key: 1 }, { unique: true });
  await collections.issues.createIndex({ parentId: 1 });
  await collections.issues.createIndex({ blockedBy: 1 });
  await collections.issues.createIndex({ assigneeAgentId: 1, status: 1 });
  await collections.issues.createIndex({ projectId: 1, status: 1, _id: 1 });
  await collections.issues.createIndex({ status: 1, updatedAt: 1 });
  await collections.issues.createIndex({ closedAt: -1 });
  await collections.issues.createIndex({ createdAt: -1 });
  await collections.issues.createIndex({ projectId: 1, columnId: 1 });
  await collections.comments.createIndex({ issueId: 1, _id: 1 });
  await collections.comments.createIndex({ createdAt: -1 });
  await collections.memories.createIndex(
    { scope: 1, projectId: 1, agentId: 1, titleKey: 1 },
    { unique: true },
  );
  await collections.memories.createIndex(
    { title: 'text', body: 'text', tags: 'text' },
    { weights: { title: 5, tags: 3, body: 1 }, name: 'memory_text' },
  );
  await collections.skills.createIndex({ name: 1 }, { unique: true });
  await collections.skills.createIndex(
    { 'source.sourceId': 1, 'source.externalId': 1 },
    { unique: true, partialFilterExpression: { 'source.sourceId': { $exists: true } } },
  );
  await collections.skillSources.createIndex(
    { name: 1 },
    { unique: true, collation: CASE_INSENSITIVE },
  );
  await collections.agents.createIndex({ skillIds: 1 });
  await collections.wakes.createIndex(
    { agentId: 1, issueId: 1 },
    { unique: true, partialFilterExpression: { processedAt: null } },
  );
  await collections.wakes.createIndex({ processedAt: 1, _id: 1 });
  // Processed wakes are kept for debugging only (runs carry their reason); pending wakes have
  // processedAt null and never expire.
  await collections.wakes.createIndex(
    { processedAt: 1 },
    { expireAfterSeconds: PROCESSED_WAKE_RETENTION_SECONDS },
  );
  await collections.runs.createIndex({ agentId: 1, issueId: 1, createdAt: -1 });
  await collections.runs.createIndex({ agentId: 1, createdAt: -1 });
  await collections.runs.createIndex({ status: 1 });
  await collections.runs.createIndex({ createdAt: -1 });
  await collections.runs.createIndex({ status: 1, finishedAt: -1 });
  await collections.runEvents.createIndex({ runId: 1, seq: 1 }, { unique: true });
  await collections.runs.createIndex(
    { tokenHash: 1 },
    { unique: true, partialFilterExpression: { tokenHash: { $type: 'string' } } },
  );
  await collections.documents.createIndex({ issueId: 1, key: 1 }, { unique: true });
  await collections.agentLinks.createIndex({ from: 1, to: 1, type: 1 }, { unique: true });
  await collections.agentLinks.createIndex({ to: 1, type: 1 });
  await collections.agentLinks.createIndex({ from: 1, type: 1 });
  await collections.notifications.createIndex({ agentId: 1, readAt: 1, _id: -1 });
  await collections.notifications.createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: NOTIFICATION_TTL_SECONDS },
  );
  await collections.revisions.createIndex({ documentId: 1, revision: 1 }, { unique: true });
  await collections.users.createIndex({ email: 1 }, { unique: true });
  await collections.users.createIndex({ role: 1 });
  await collections.sessions.createIndex({ token: 1 }, { unique: true });
  await collections.sessions.createIndex({ userId: 1 });
  await collections.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await collections.apiTokens.createIndex({ tokenHash: 1 }, { unique: true });
  await collections.apiTokens.createIndex({ userId: 1, createdAt: -1 });
  await collections.audit.createIndex({ at: -1 });
  await collections.audit.createIndex({ targetUserId: 1, at: -1 });
  await collections.audit.createIndex({ action: 1, _id: -1 });
  await collections.audit.createIndex({ 'actor.userId': 1, _id: -1 });
  await ensureChatIndexes(collections);
  await collections.avatars.createIndex({ 'owner.type': 1, 'owner.id': 1 }, { unique: true });
}
