import type { ObjectId } from 'mongodb';
import type { AgentSummary, Org } from '@conclavix/core';
import { dropProjectOverrides } from '../projects/overrides.js';
import { LOCKS, ORG_DOC_ID, lock, type AgentDoc, type Database } from '../../db.js';
import { unprocessable } from '../../errors.js';
import { findRoots, resolveLead } from './lead.js';
import { linkedAgents } from './links.js';

const MAX_CANDIDATES = 100;

/** Convert a stored agent to the short form used in org responses. */
export const toAgentSummary = (doc: AgentDoc): AgentSummary => ({
  id: doc._id.toHexString(),
  name: doc.name,
  role: doc.role,
  title: doc.title,
});

/** Org-wide configuration: currently the lead agent. */
export class OrgRepository {
  constructor(private readonly database: Database) {}

  /** Return the org, bootstrapping the lead from a single root agent if none is set. */
  async get(): Promise<Org> {
    const { collections } = this.database;
    const lead = await resolveLead(this.database);
    const [org, candidates] = await Promise.all([
      collections.org.findOne({ _id: ORG_DOC_ID }),
      lead ? Promise.resolve([]) : findRoots(collections, MAX_CANDIDATES),
    ]);
    return {
      leadAgentId: lead ? lead._id.toHexString() : null,
      lead: lead ? toAgentSummary(lead) : null,
      leadCandidates: candidates.map(toAgentSummary),
      updatedAt: org?.updatedAt ?? null,
    };
  }

  /**
   * Make the agent the lead under the org-chart lock. 422 if the agent does not exist or someone
   * delegates to it: the lead takes work from the board only, so those links must go first.
   * The lead is enabled in every project, so its project overrides are dropped.
   */
  async setLead(agentId: ObjectId): Promise<Org> {
    const { collections } = this.database;
    await this.database.inTransaction(async (session) => {
      await lock(collections, LOCKS.orgChart, session);
      const agent = await collections.agents.findOne(
        { _id: agentId },
        { projection: { _id: 1 }, session },
      );
      if (!agent) {
        throw unprocessable('agentId refers to an agent that does not exist');
      }
      const delegators = await linkedAgents(collections, agentId, 'delegates', 'incoming', session);
      if (delegators.length > 0) {
        throw unprocessable(
          `the lead cannot have delegators; remove the delegation links from ${delegators
            .map((agent) => agent.name)
            .join(', ')} first`,
          { delegators: delegators.map(toAgentSummary) },
        );
      }
      await collections.org.updateOne(
        { _id: ORG_DOC_ID },
        { $set: { leadAgentId: agentId, updatedAt: new Date() } },
        { upsert: true, session },
      );
      await dropProjectOverrides(collections, agentId, session);
    });
    return this.get();
  }
}
