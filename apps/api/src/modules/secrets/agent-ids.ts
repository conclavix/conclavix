import { ObjectId, type ClientSession } from 'mongodb';
import type { Collections } from '../../db.js';
import { unprocessable } from '../../errors.js';

/**
 * The agents to store on a secret or connection: unknown ids are refused, except ids already
 * stored (`current`) whose agent was deleted since, which are dropped.
 */
export async function checkAgentIds(
  collections: Collections,
  ids: readonly string[],
  session: ClientSession,
  current: readonly ObjectId[] = [],
): Promise<ObjectId[]> {
  const objectIds = ids.map((id) => new ObjectId(id));
  const existing = await collections.agents
    .find({ _id: { $in: objectIds } }, { session, projection: { _id: 1 } })
    .toArray();
  const known = new Set(existing.map((agent) => agent._id.toHexString()));
  const before = new Set(current.map((id) => id.toHexString()));
  if (ids.some((id) => !known.has(id) && !before.has(id))) {
    throw unprocessable('Unknown agent in agentIds');
  }
  return objectIds.filter((id) => known.has(id.toHexString()));
}
