import type { ClientSession, ObjectId } from 'mongodb';
import {
  LOCKS,
  ORG_DOC_ID,
  lock,
  type AgentDoc,
  type Collections,
  type Database,
} from '../../db.js';
import { dropProjectOverrides } from '../projects/overrides.js';

/** Agents nobody delegates to, at most `limit`, sorted by name. */
export async function findRoots(
  collections: Collections,
  limit: number,
  session?: ClientSession,
): Promise<AgentDoc[]> {
  const options = session ? { session } : {};
  const delegated = await collections.agentLinks.distinct('to', { type: 'delegates' }, options);
  return collections.agents
    .find({ _id: { $nin: delegated } }, options)
    .sort({ name: 1 })
    .limit(limit)
    .toArray();
}

/** The stored lead id, or null when none is set. */
export async function storedLeadId(
  collections: Collections,
  session?: ClientSession,
): Promise<ObjectId | null> {
  const org = await collections.org.findOne({ _id: ORG_DOC_ID }, session ? { session } : {});
  return org?.leadAgentId ?? null;
}

/**
 * Persist the only agent nobody delegates to as lead when no lead is set yet. Runs under the
 * org-chart lock so it cannot race a link change or an explicit lead change.
 * Returns null when the lead stays unset.
 */
async function bootstrapLead(database: Database): Promise<AgentDoc | null> {
  const { collections } = database;
  return database.inTransaction(async (session) => {
    await lock(collections, LOCKS.orgChart, session);
    const current = await storedLeadId(collections, session);
    if (current) {
      return collections.agents.findOne({ _id: current }, { session });
    }
    const roots = await findRoots(collections, 2, session);
    const only = roots.length === 1 ? roots[0] : undefined;
    if (!only) {
      return null;
    }
    await collections.org.updateOne(
      { _id: ORG_DOC_ID },
      { $set: { leadAgentId: only._id, updatedAt: new Date() } },
      { upsert: true, session },
    );
    await dropProjectOverrides(collections, only._id, session);
    return only;
  });
}

/**
 * The organisation's lead agent. When none is set and exactly one agent has no delegator, that
 * agent becomes the lead and is persisted; otherwise the lead stays unset for the board to pick.
 */
export async function resolveLead(database: Database): Promise<AgentDoc | null> {
  const { collections } = database;
  const leadId = await storedLeadId(collections);
  if (leadId) {
    return collections.agents.findOne({ _id: leadId });
  }
  const roots = await findRoots(collections, 2);
  return roots.length === 1 ? bootstrapLead(database) : null;
}

/** True if the agent is the organisation's lead. */
export async function isLead(database: Database, agentId: ObjectId): Promise<boolean> {
  const lead = await resolveLead(database);
  return lead !== null && lead._id.equals(agentId);
}
