import type { ClientSession, ObjectId } from 'mongodb';
import type { Collections } from '../../db.js';

/**
 * Remove an agent's overrides from every project: when it is deleted, and when it becomes the
 * lead, which is always enabled, so an old override would otherwise return unseen later.
 */
export async function dropProjectOverrides(
  collections: Collections,
  agentId: ObjectId,
  session: ClientSession,
): Promise<void> {
  await collections.projects.updateMany(
    { 'agentOverrides.agentId': agentId },
    { $pull: { agentOverrides: { agentId } } },
    { session },
  );
}
