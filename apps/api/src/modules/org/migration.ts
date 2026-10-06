import { ObjectId } from 'mongodb';
import { LOCKS, ORG_DOC_ID, lock, type Database } from '../../db.js';

/**
 * Convert the tree in `reportsTo` into links once: manager M of agent A becomes `delegates M->A`
 * and `reports A->M`. A marker on the org document makes it run only once, so links the board
 * deletes later are not recreated; the org-chart lock serializes concurrently starting processes.
 * A `reportsTo` naming a missing agent is skipped. Returns the number of agents that had a
 * manager, or null if the migration had already run.
 */
export async function migrateReportsToLinks(database: Database): Promise<number | null> {
  const { collections } = database;
  return database.inTransaction(async (session) => {
    await lock(collections, LOCKS.orgChart, session);
    const org = await collections.org.findOne({ _id: ORG_DOC_ID }, { session });
    if (org?.linksMigratedAt) {
      return null;
    }
    const managed = await collections.agents
      .find({ reportsTo: { $ne: null } }, { projection: { reportsTo: 1 }, session })
      .toArray();
    const existing = new Set(
      (await collections.agents.find({}, { projection: { _id: 1 }, session }).toArray()).map(
        (agent) => agent._id.toHexString(),
      ),
    );
    const now = new Date();
    for (const agent of managed) {
      const managerId = agent.reportsTo;
      if (!managerId || !existing.has(managerId.toHexString())) {
        continue;
      }
      for (const [from, to, type] of [
        [managerId, agent._id, 'delegates'],
        [agent._id, managerId, 'reports'],
      ] as const) {
        await collections.agentLinks.updateOne(
          { from, to, type },
          { $setOnInsert: { _id: new ObjectId(), from, to, type, createdAt: now } },
          { upsert: true, session },
        );
      }
    }
    await collections.org.updateOne(
      { _id: ORG_DOC_ID },
      {
        $set: { linksMigratedAt: now, updatedAt: now },
        $setOnInsert: { leadAgentId: null },
      },
      { upsert: true, session },
    );
    return managed.length;
  });
}
