import { ObjectId, type ClientSession } from 'mongodb';
import type {
  AgentLink,
  CreateAgentLinkInput,
  OrgGraph,
  SetLayoutInput,
  UpdateAgentLinkInput,
} from '@conclavix/core';
import { LOCKS, lock, type Database } from '../../db.js';
import { notFound, unprocessable } from '../../errors.js';
import { storedLeadId } from './lead.js';
import { deleteLink, insertLink, toAgentLink } from './links.js';
import { toAgentSummary } from './repository.js';

/** The agent graph for the canvas: agents with positions, delegation and reporting links. */
export class OrgGraphRepository {
  constructor(private readonly database: Database) {}

  private get collections() {
    return this.database.collections;
  }

  private change<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    return this.database.inTransaction(async (session) => {
      await lock(this.collections, LOCKS.orgChart, session);
      return work(session);
    });
  }

  async graph(): Promise<OrgGraph> {
    const [leadId, agents, links, layout] = await Promise.all([
      storedLeadId(this.collections),
      this.collections.agents.find().sort({ name: 1 }).toArray(),
      this.collections.agentLinks.find().sort({ _id: 1 }).toArray(),
      this.collections.orgLayout.find().toArray(),
    ]);
    const positions = new Map(layout.map((doc) => [doc._id.toHexString(), doc]));
    return {
      leadAgentId: leadId ? leadId.toHexString() : null,
      agents: agents.map((agent) => {
        const position = positions.get(agent._id.toHexString());
        return {
          ...toAgentSummary(agent),
          status: agent.status,
          adapterType: agent.adapter.type,
          model: agent.adapter.model ?? null,
          position: position ? { x: position.x, y: position.y } : null,
        };
      }),
      links: links.map(toAgentLink),
    };
  }

  async createLink(input: CreateAgentLinkInput): Promise<AgentLink> {
    const doc = await this.change((session) =>
      insertLink(
        this.collections,
        new ObjectId(input.from),
        new ObjectId(input.to),
        input.type,
        session,
        input.wakeOnReport === undefined ? {} : { wakeOnReport: input.wakeOnReport },
      ),
    );
    return toAgentLink(doc);
  }

  /** Change a link's options; 404 if it is gone, 422 for wakeOnReport on a delegates link. */
  async updateLink(id: ObjectId, input: UpdateAgentLinkInput): Promise<AgentLink> {
    const doc = await this.change(async (session) => {
      const current = await this.collections.agentLinks.findOne({ _id: id }, { session });
      if (!current) {
        throw notFound('Link');
      }
      if (current.type !== 'reports') {
        throw unprocessable('wakeOnReport applies to reports links only');
      }
      return this.collections.agentLinks.findOneAndUpdate(
        { _id: id },
        { $set: { wakeOnReport: input.wakeOnReport } },
        { returnDocument: 'after', session },
      );
    });
    if (!doc) {
      throw notFound('Link');
    }
    return toAgentLink(doc);
  }

  async removeLink(id: ObjectId): Promise<void> {
    const deleted = await this.change((session) => deleteLink(this.collections, id, session));
    if (!deleted) {
      throw notFound('Link');
    }
  }

  /** Store canvas positions; 422 if any agent id is unknown. */
  async setLayout(input: SetLayoutInput): Promise<void> {
    const byAgent = new Map(input.positions.map((entry) => [entry.agentId, entry]));
    const ids = [...byAgent.keys()].map((id) => new ObjectId(id));
    await this.change(async (session) => {
      const found = await this.collections.agents.countDocuments(
        { _id: { $in: ids } },
        { session },
      );
      if (found !== ids.length) {
        throw unprocessable('positions refer to an agent that does not exist');
      }
      const now = new Date();
      await this.collections.orgLayout.bulkWrite(
        [...byAgent.values()].map(({ agentId, x, y }) => ({
          updateOne: {
            filter: { _id: new ObjectId(agentId) },
            update: { $set: { x, y, updatedAt: now } },
            upsert: true,
          },
        })),
        { session },
      );
    });
  }
}
