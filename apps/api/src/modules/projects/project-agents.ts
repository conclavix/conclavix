import { ObjectId, type ClientSession } from 'mongodb';
import { CLOSED_ISSUE_STATUSES, type ProjectAgent } from '@conclavix/core';
import { LOCKS, lock, type AgentDoc, type Database, type ProjectDoc } from '../../db.js';
import { AppError, notFound } from '../../errors.js';
import type { AuditActor, AuditLog } from '../audit/audit.js';
import { avatarUrl } from '../avatars/url.js';
import { resolveLead, storedLeadId } from '../org/lead.js';
import { accessOf, overrideFor } from './agent-access.js';

/** How an override reads in the audit log: the stored value, or 'default' when there is none. */
const overrideLabel = (value: boolean | null): string =>
  value === null ? 'default' : value ? 'enabled' : 'disabled';

export interface AccessChange {
  actor: AuditActor;
  ip: string | null;
}

function toProjectAgent(
  agent: AgentDoc,
  project: ProjectDoc,
  leadId: ObjectId | null,
  openIssues: number,
): ProjectAgent {
  const isLead = leadId !== null && leadId.equals(agent._id);
  return {
    id: agent._id.toHexString(),
    name: agent.name,
    role: agent.role,
    title: agent.title,
    status: agent.status,
    avatarUrl: avatarUrl('agent', agent._id.toHexString(), agent.avatarEtag),
    projectDefault: agent.projectDefault ?? 'enabled',
    override: isLead ? null : overrideFor(project, agent._id),
    isLead,
    openIssues,
    ...accessOf(agent, project, leadId),
  };
}

/** Which agents may work in a project: the agents' defaults plus the project's overrides. */
export class ProjectAgentsService {
  constructor(
    private readonly database: Database,
    private readonly audit: AuditLog,
  ) {}

  private get collections() {
    return this.database.collections;
  }

  private async project(id: ObjectId, session?: ClientSession): Promise<ProjectDoc> {
    const project = await this.collections.projects.findOne(
      { _id: id },
      session ? { session } : {},
    );
    if (!project) {
      throw notFound('Project');
    }
    return project;
  }

  private async openIssues(
    projectId: ObjectId,
    agentId?: ObjectId,
    session?: ClientSession,
  ): Promise<Map<string, number>> {
    const rows = await this.collections.issues
      .aggregate<{ _id: ObjectId; count: number }>(
        [
          {
            $match: {
              projectId,
              assigneeAgentId: agentId ?? { $ne: null },
              status: { $nin: [...CLOSED_ISSUE_STATUSES] },
            },
          },
          { $group: { _id: '$assigneeAgentId', count: { $sum: 1 } } },
        ],
        session ? { session } : {},
      )
      .toArray();
    return new Map(rows.map((row) => [row._id.toHexString(), row.count]));
  }

  /** Every agent with its effective state in the project, the lead first, then by name. */
  async list(projectId: ObjectId): Promise<ProjectAgent[]> {
    const project = await this.project(projectId);
    const [lead, agents, counts] = await Promise.all([
      resolveLead(this.database),
      this.collections.agents.find().sort({ name: 1 }).toArray(),
      this.openIssues(projectId),
    ]);
    const leadId = lead?._id ?? null;
    return agents
      .map((agent) =>
        toProjectAgent(agent, project, leadId, counts.get(agent._id.toHexString()) ?? 0),
      )
      .sort((a, b) => Number(b.isLead) - Number(a.isLead));
  }

  /**
   * Set (true/false) or remove (null) the project's override for one agent, with an audit entry
   * in the same transaction. The lead cannot be disabled (409 lead_always_enabled). Runs under
   * the org-chart lock that issue assignment takes, so no assignment slips past a change.
   */
  async set(
    projectId: ObjectId,
    agentId: ObjectId,
    enabled: boolean | null,
    change: AccessChange,
  ): Promise<ProjectAgent> {
    return this.database.inTransaction(async (session) => {
      await lock(this.collections, LOCKS.orgChart, session);
      const project = await this.project(projectId, session);
      const agent = await this.collections.agents.findOne({ _id: agentId }, { session });
      if (!agent) {
        throw notFound('Agent');
      }
      const leadId = await storedLeadId(this.collections, session);
      if (enabled === false && leadId?.equals(agentId)) {
        throw new AppError(
          409,
          'lead_always_enabled',
          `${agent.name} is the lead and is always enabled in every project`,
        );
      }
      const isLead = leadId?.equals(agentId) ?? false;
      const before = accessOf(agent, project, leadId);
      const previous = overrideFor(project, agentId);
      // The lead stores no override at all: it would be invisible now and apply after a lead change.
      if (previous === enabled || isLead) {
        // Nothing changes (e.g. a repeated click), so no write and no audit entry.
        const counts = await this.openIssues(projectId, agentId, session);
        return toProjectAgent(agent, project, leadId, counts.get(agentId.toHexString()) ?? 0);
      }
      const now = new Date();
      await this.collections.projects.updateOne(
        { _id: projectId },
        { $pull: { agentOverrides: { agentId } }, $set: { updatedAt: now } },
        { session },
      );
      if (enabled !== null) {
        await this.collections.projects.updateOne(
          { _id: projectId },
          { $push: { agentOverrides: { agentId, enabled, updatedAt: now } } },
          { session },
        );
      }
      const updated = await this.project(projectId, session);
      const counts = await this.openIssues(projectId, agentId, session);
      const result = toProjectAgent(agent, updated, leadId, counts.get(agentId.toHexString()) ?? 0);
      await this.audit.write(
        {
          action: 'project.agent_access_changed',
          actor: change.actor,
          ip: change.ip,
          // Flat, plain values: the audit view shows those and hides key-like field names.
          details: {
            projectId: projectId.toHexString(),
            project: project.key,
            agentId: agentId.toHexString(),
            agent: agent.name,
            from: overrideLabel(previous),
            to: overrideLabel(enabled),
            effective: result.enabled ? 'enabled' : 'disabled',
            wasEffective: before.enabled ? 'enabled' : 'disabled',
            openIssues: result.openIssues,
          },
        },
        session,
      );
      return result;
    });
  }
}
