import { ObjectId, type ClientSession } from 'mongodb';
import type { AgentLink, AgentLinkType } from '@conclavix/core';
import type { AgentDoc, AgentLinkDoc, Collections } from '../../db.js';
import { conflict, isDuplicateKeyError, unprocessable } from '../../errors.js';
import { storedLeadId } from './lead.js';

const MAX_CYCLE_SCAN = 5000;

/** Convert a stored link to its API shape. */
export const toAgentLink = (doc: AgentLinkDoc): AgentLink => ({
  id: doc._id.toHexString(),
  from: doc.from.toHexString(),
  to: doc.to.toHexString(),
  type: doc.type,
  wakeOnReport: doc.type === 'reports' && doc.wakeOnReport === true,
  createdAt: doc.createdAt,
});

const opts = (session?: ClientSession) => (session ? { session } : {});

/** Agents on the other end of an agent's links of one type and direction, sorted by name. */
export async function linkedAgents(
  collections: Collections,
  agentId: ObjectId,
  type: AgentLinkType,
  direction: 'outgoing' | 'incoming',
  session?: ClientSession,
): Promise<AgentDoc[]> {
  const [mine, other] =
    direction === 'outgoing' ? (['from', 'to'] as const) : (['to', 'from'] as const);
  const links = await collections.agentLinks
    .find({ [mine]: agentId, type }, { projection: { [other]: 1 }, ...opts(session) })
    .toArray();
  const ids = links.map((link) => link[other]);
  if (ids.length === 0) {
    return [];
  }
  return collections.agents
    .find({ _id: { $in: ids } }, opts(session))
    .sort({ name: 1 })
    .toArray();
}

/** The agent's outgoing `reports` links with their targets, sorted by target name. */
export async function reportTargets(
  collections: Collections,
  agentId: ObjectId,
  session: ClientSession,
): Promise<{ agent: AgentDoc; wakeOnReport: boolean }[]> {
  const links = await collections.agentLinks
    .find({ from: agentId, type: 'reports' }, { projection: { to: 1, wakeOnReport: 1 }, session })
    .toArray();
  const wakes = new Map(links.map((link) => [link.to.toHexString(), link.wakeOnReport === true]));
  const agents = await linkedAgents(collections, agentId, 'reports', 'outgoing', session);
  return agents.map((agent) => ({
    agent,
    wakeOnReport: wakes.get(agent._id.toHexString()) ?? false,
  }));
}

/** True if a `delegates` link from -> to exists. */
export async function delegatesTo(
  collections: Collections,
  from: ObjectId,
  to: ObjectId,
  session?: ClientSession,
): Promise<boolean> {
  const link = await collections.agentLinks.findOne(
    { from, to, type: 'delegates' },
    { projection: { _id: 1 }, ...opts(session) },
  );
  return link !== null;
}

/**
 * Find a delegation path start -> ... -> target, or null. Adding target -> start would close it
 * into a cycle. Breadth-first, so the reported path is a shortest one.
 */
async function delegationPath(
  collections: Collections,
  start: ObjectId,
  target: ObjectId,
  session: ClientSession,
): Promise<ObjectId[] | null> {
  const previous = new Map<string, ObjectId | null>([[start.toHexString(), null]]);
  let frontier = [start];
  while (frontier.length > 0) {
    const links = await collections.agentLinks
      .find({ from: { $in: frontier }, type: 'delegates' }, { session })
      .toArray();
    frontier = [];
    for (const link of links) {
      const key = link.to.toHexString();
      if (previous.has(key)) {
        continue;
      }
      previous.set(key, link.from);
      if (link.to.equals(target)) {
        const path: ObjectId[] = [];
        for (let at: ObjectId | null = link.to; at; at = previous.get(at.toHexString()) ?? null) {
          path.unshift(at);
        }
        return path;
      }
      frontier.push(link.to);
    }
    if (previous.size > MAX_CYCLE_SCAN) {
      throw unprocessable('delegation graph is too large to validate');
    }
  }
  return null;
}

/** Name the agents on a path for an error message. */
async function describePath(
  collections: Collections,
  path: ObjectId[],
  session: ClientSession,
): Promise<string> {
  const agents = await collections.agents
    .find({ _id: { $in: path } }, { projection: { name: 1 }, session })
    .toArray();
  const names = new Map(agents.map((agent) => [agent._id.toHexString(), agent.name]));
  return path.map((id) => names.get(id.toHexString()) ?? id.toHexString()).join(' -> ');
}

/**
 * Validate and insert a link inside a transaction that holds the org-chart lock.
 * 422 for self-links, unknown agents, delegation to the lead, a delegation cycle, or wakeOnReport
 * on a delegates link; 409 for duplicates.
 */
export async function insertLink(
  collections: Collections,
  from: ObjectId,
  to: ObjectId,
  type: AgentLinkType,
  session: ClientSession,
  options: { wakeOnReport?: boolean } = {},
): Promise<AgentLinkDoc> {
  if (options.wakeOnReport === true && type !== 'reports') {
    throw unprocessable('wakeOnReport applies to reports links only');
  }
  if (from.equals(to)) {
    throw unprocessable('an agent cannot link to itself');
  }
  const found = await collections.agents.countDocuments({ _id: { $in: [from, to] } }, { session });
  if (found !== 2) {
    throw unprocessable('link refers to an agent that does not exist');
  }
  if (type === 'delegates') {
    const leadId = await storedLeadId(collections, session);
    if (leadId?.equals(to)) {
      throw unprocessable('nobody can delegate to the lead');
    }
    const path = await delegationPath(collections, to, from, session);
    if (path) {
      const cycle = [from, ...path];
      throw unprocessable(
        `delegation would create a cycle: ${await describePath(collections, cycle, session)}`,
        { cycle: cycle.map((id) => id.toHexString()) },
      );
    }
  }
  const doc: AgentLinkDoc = {
    _id: new ObjectId(),
    from,
    to,
    type,
    ...(type === 'reports' ? { wakeOnReport: options.wakeOnReport === true } : {}),
    createdAt: new Date(),
  };
  try {
    await collections.agentLinks.insertOne(doc, { session });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw conflict('this link already exists');
    }
    throw error;
  }
  if (type === 'delegates') {
    await syncReportsTo(collections, [to], session);
  }
  return doc;
}

/** Delete a link and refresh the compatibility field; returns the deleted link or null. */
export async function deleteLink(
  collections: Collections,
  id: ObjectId,
  session: ClientSession,
): Promise<AgentLinkDoc | null> {
  const link = await collections.agentLinks.findOneAndDelete({ _id: id }, { session });
  if (link) {
    await syncReportsTo(collections, [link.to], session);
  }
  return link;
}

/**
 * Store the deprecated `reportsTo` field as the agent's single delegator, or null when it has
 * none or several. It keeps older readers of the agent document working.
 */
export async function syncReportsTo(
  collections: Collections,
  agentIds: ObjectId[],
  session: ClientSession,
): Promise<void> {
  for (const agentId of agentIds) {
    const delegators = await collections.agentLinks
      .find({ to: agentId, type: 'delegates' }, { projection: { from: 1 }, session })
      .limit(2)
      .toArray();
    const only = delegators.length === 1 ? (delegators[0]?.from ?? null) : null;
    await collections.agents.updateOne(
      { _id: agentId },
      { $set: { reportsTo: only } },
      { session },
    );
  }
}

/**
 * Deprecated tree behaviour behind `reportsTo`: replace the agent's incoming delegation and
 * outgoing reporting links with a single manager, or remove them when the manager is null.
 */
export async function replaceManager(
  collections: Collections,
  agentId: ObjectId,
  managerId: ObjectId | null,
  session: ClientSession,
): Promise<void> {
  await collections.agentLinks.deleteMany(
    {
      $or: [
        { to: agentId, type: 'delegates' },
        { from: agentId, type: 'reports' },
      ],
    },
    { session },
  );
  if (managerId) {
    await insertLink(collections, managerId, agentId, 'delegates', session);
    await insertLink(collections, agentId, managerId, 'reports', session);
  }
  await syncReportsTo(collections, [agentId], session);
}

/** Remove every link and the canvas position of an agent that is being deleted. */
export async function removeAgentLinks(
  collections: Collections,
  agentId: ObjectId,
  session: ClientSession,
): Promise<void> {
  const delegated = await collections.agentLinks
    .find({ from: agentId, type: 'delegates' }, { projection: { to: 1 }, session })
    .toArray();
  await collections.agentLinks.deleteMany(
    { $or: [{ from: agentId }, { to: agentId }] },
    { session },
  );
  await collections.orgLayout.deleteOne({ _id: agentId }, { session });
  await syncReportsTo(
    collections,
    delegated.map((link) => link.to),
    session,
  );
}
