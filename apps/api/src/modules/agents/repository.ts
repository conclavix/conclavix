import { ObjectId, type ClientSession } from 'mongodb';
import type { Agent, CreateAgentInput, OrgChartNode, UpdateAgentInput } from '@conclavix/core';
import { LOCKS, ORG_DOC_ID, lock, type AgentDoc, type Database } from '../../db.js';
import { CLOSED_ISSUE_STATUSES } from '@conclavix/core';
import { conflict, isDuplicateKeyError, notFound } from '../../errors.js';
import { definedOnly } from '../../validation.js';
import { assertSkillsExist } from '../skills/repository.js';
import { avatarUrl } from '../avatars/url.js';
import { removeAgentLinks, replaceManager } from '../org/links.js';
import { buildOrgChart } from './org-chart.js';
import { dropProjectOverrides } from '../projects/overrides.js';

/** Convert a stored agent to its domain representation with hexadecimal IDs. */
const toAgent = (doc: AgentDoc): Agent => ({
  id: doc._id.toHexString(),
  name: doc.name,
  role: doc.role,
  title: doc.title,
  reportsTo: doc.reportsTo ? doc.reportsTo.toHexString() : null,
  adapter: doc.adapter,
  limits: doc.limits,
  instructions: doc.instructions,
  status: doc.status,
  skillIds: (doc.skillIds ?? []).map((id) => id.toHexString()),
  projectDefault: doc.projectDefault ?? 'enabled',
  codeAccess: doc.codeAccess ?? 'none',
  avatarUrl: avatarUrl('agent', doc._id.toHexString(), doc.avatarEtag),
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

/** Convert a validated manager ID to an ObjectId, preserving null for root agents. */
const toManagerId = (reportsTo: string | null): ObjectId | null =>
  reportsTo === null ? null : new ObjectId(reportsTo);

/** Run a write and translate duplicate-key errors into agent-name conflicts. */
async function withUniqueName<T>(name: string | undefined, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw conflict(`An agent named ${name ?? ''} already exists`);
    }
    throw error;
  }
}

export class AgentRepository {
  /** Use the supplied database for agent persistence and transactional org-chart changes. */
  constructor(private readonly database: Database) {}

  private get collections() {
    return this.database.collections;
  }

  /** Return the agent collection associated with this repository. */
  private get agents() {
    return this.database.collections.agents;
  }

  /** Run an org-chart change in a transaction after acquiring the shared chart lock. */
  private changeOrgChart<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    return this.database.inTransaction(async (session) => {
      await lock(this.database.collections, LOCKS.orgChart, session);
      return work(session);
    });
  }

  /** Return all agents sorted by name. */
  async list(): Promise<Agent[]> {
    const docs = await this.agents.find().sort({ name: 1 }).toArray();
    return docs.map(toAgent);
  }

  /** Return the org-chart forest with roots and direct reports sorted by name. */
  async orgChart(): Promise<OrgChartNode[]> {
    const docs = await this.agents.find().sort({ name: 1 }).toArray();
    return buildOrgChart(docs);
  }

  /** Return the agent with the given ID, or raise a 404 error if it does not exist. */
  async get(id: ObjectId): Promise<Agent> {
    const doc = await this.agents.findOne({ _id: id });
    if (!doc) {
      throw notFound('Agent');
    }
    return toAgent(doc);
  }

  /**
   * Create an active agent. A `reportsTo` (deprecated) becomes `delegates manager->agent` and
   * `reports agent->manager` links. Duplicate names raise 409; invalid links raise 422.
   * `onCreated` runs in the same transaction (audit entries).
   */
  async create(
    input: CreateAgentInput,
    onCreated?: (created: AgentDoc, session: ClientSession) => Promise<void>,
  ): Promise<Agent> {
    const now = new Date();
    const doc: AgentDoc = {
      _id: new ObjectId(),
      ...input,
      reportsTo: null,
      skillIds: [],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    const created = await this.changeOrgChart(async (session) => {
      if (input.skillIds.length > 0) {
        doc.skillIds = await assertSkillsExist(this.database.collections, input.skillIds, session);
      }
      await withUniqueName(input.name, () => this.agents.insertOne(doc, { session }));
      await onCreated?.(doc, session);
      if (input.reportsTo !== null) {
        await replaceManager(this.collections, doc._id, new ObjectId(input.reportsTo), session);
      }
      return this.agents.findOne({ _id: doc._id }, { session });
    });
    if (!created) {
      throw notFound('Agent');
    }
    return toAgent(created);
  }

  /**
   * Apply defined fields from validated input in a transaction. A `reportsTo` (deprecated)
   * replaces the agent's delegators and report targets with that single manager. `onUpdated`
   * sees the agent as it was and runs in the same transaction (audit entries).
   * Raise 404 for a missing agent, 409 for a duplicate name, or 422 for invalid links.
   */
  async update(
    id: ObjectId,
    input: UpdateAgentInput,
    onUpdated?: (before: AgentDoc, session: ClientSession) => Promise<void>,
  ): Promise<Agent> {
    const { reportsTo, skillIds, ...rest } = input;
    const changes: Partial<AgentDoc> = { ...definedOnly(rest), updatedAt: new Date() };
    const doc = await this.changeOrgChart(async (session) => {
      if (skillIds !== undefined) {
        changes.skillIds = await assertSkillsExist(this.database.collections, skillIds, session);
      }
      const updated = await withUniqueName(input.name, () =>
        this.agents.findOneAndUpdate({ _id: id }, { $set: changes }, { session }),
      );
      if (!updated) {
        throw notFound('Agent');
      }
      await onUpdated?.(updated, session);
      if (reportsTo !== undefined) {
        await replaceManager(this.collections, id, toManagerId(reportsTo), session);
      }
      return this.agents.findOne({ _id: id }, { session });
    });
    if (!doc) {
      throw notFound('Agent');
    }
    return toAgent(doc);
  }

  /**
   * Delete an agent and its links, project overrides, canvas position and notifications in one
   * transaction.
   * Raise 409 if it has open issues or is the lead while other agents exist, 404 if it is absent.
   * Deleting the last agent clears the lead.
   */
  async remove(id: ObjectId): Promise<void> {
    await this.changeOrgChart(async (session) => {
      const { org } = this.collections;
      const isLead = (await org.findOne({ _id: ORG_DOC_ID }, { session }))?.leadAgentId?.equals(id);
      if (isLead) {
        const others = await this.agents.countDocuments({ _id: { $ne: id } }, { session });
        if (others > 0) {
          throw conflict('Agent is the lead; set another lead first', { others });
        }
        await org.updateOne(
          { _id: ORG_DOC_ID },
          { $set: { leadAgentId: null, updatedAt: new Date() } },
          { session },
        );
      }
      const openIssues = await this.collections.issues.countDocuments(
        { assigneeAgentId: id, status: { $nin: [...CLOSED_ISSUE_STATUSES] } },
        { session },
      );
      if (openIssues > 0) {
        throw conflict('Agent still has open issues; reassign them first', { openIssues });
      }
      const result = await this.agents.deleteOne({ _id: id }, { session });
      if (result.deletedCount === 0) {
        throw notFound('Agent');
      }
      await removeAgentLinks(this.collections, id, session);
      await dropProjectOverrides(this.collections, id, session);
      await this.collections.notifications.deleteMany({ agentId: id }, { session });
      await this.database.collections.avatars.deleteOne(
        { 'owner.type': 'agent', 'owner.id': id.toHexString() },
        { session },
      );
    });
  }
}
