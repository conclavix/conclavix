import type { ClientSession, Filter, ObjectId } from 'mongodb';
import { resolveProjectAgentAccess, type ProjectAgentAccess } from '@conclavix/core';
import type { AgentDoc, Collections, IssueDoc, ProjectDoc } from '../../db.js';
import { AppError } from '../../errors.js';
import { storedLeadId } from '../org/lead.js';

type AccessAgent = Pick<AgentDoc, '_id' | 'projectDefault'>;
type AccessProject = Pick<ProjectDoc, '_id' | 'key' | 'agentOverrides'>;

const opts = (session?: ClientSession) => (session ? { session } : {});

/** The project's stored override for an agent, or null when its project default applies. */
export function overrideFor(project: AccessProject | null, agentId: ObjectId): boolean | null {
  return project?.agentOverrides?.find((entry) => entry.agentId.equals(agentId))?.enabled ?? null;
}

/** Effective access of an agent to a project; without a project the agent's default applies. */
export function accessOf(
  agent: AccessAgent,
  project: AccessProject | null,
  leadId: ObjectId | null,
): ProjectAgentAccess {
  return resolveProjectAgentAccess(
    agent.projectDefault,
    overrideFor(project, agent._id),
    leadId !== null && leadId.equals(agent._id),
  );
}

/** The error every write path raises when work would go to an agent disabled in the project. */
export function agentDisabledInProject(
  agent: Pick<AgentDoc, '_id' | 'name'>,
  project: Pick<ProjectDoc, '_id' | 'key'>,
): AppError {
  return new AppError(
    422,
    'agent_disabled_in_project',
    `${agent.name} is not enabled in project ${project.key}; enable it on the project's Agents tab or pick another agent`,
    {
      agentId: agent._id.toHexString(),
      projectId: project._id.toHexString(),
      projectKey: project.key,
    },
  );
}

async function loadProject(
  collections: Collections,
  projectId: ObjectId,
  session?: ClientSession,
): Promise<AccessProject | null> {
  return collections.projects.findOne(
    { _id: projectId },
    { projection: { key: 1, agentOverrides: 1 }, ...opts(session) },
  );
}

/**
 * A check for many agents against one project, loading the project and the lead once. Every
 * issue belongs to a project; should the project be gone, each agent's default applies.
 */
export async function projectAccessChecker(
  collections: Collections,
  projectId: ObjectId,
  session?: ClientSession,
): Promise<{ project: AccessProject | null; isEnabled: (agent: AccessAgent) => boolean }> {
  const [project, leadId] = await Promise.all([
    loadProject(collections, projectId, session),
    storedLeadId(collections, session),
  ]);
  return { project, isEnabled: (agent) => accessOf(agent, project, leadId).enabled };
}

/**
 * Reject giving work in a project to an agent that is not enabled there. Call it under the
 * org-chart lock, which project access changes take as well, so the two cannot interleave.
 */
export async function assertAgentEnabledInProject(
  collections: Collections,
  agentId: ObjectId,
  projectId: ObjectId,
  session?: ClientSession,
): Promise<void> {
  const agent = await collections.agents.findOne(
    { _id: agentId },
    { projection: { name: 1, projectDefault: 1 }, ...opts(session) },
  );
  if (!agent) {
    return;
  }
  const { project, isEnabled } = await projectAccessChecker(collections, projectId, session);
  if (!isEnabled(agent)) {
    throw agentDisabledInProject(
      agent,
      project ?? { _id: projectId, key: projectId.toHexString() },
    );
  }
}

/**
 * Issue filters matching open work of agents that are not enabled in the issue's project: issues
 * of a project that disables the agent, and issues of an agent disabled by default outside the
 * projects that enable it. The lead is never matched. Used to skip heartbeats for such issues.
 */
export async function disabledAssignments(collections: Collections): Promise<Filter<IssueDoc>[]> {
  const [leadId, projects, defaultOff] = await Promise.all([
    storedLeadId(collections),
    collections.projects
      .find({ 'agentOverrides.0': { $exists: true } }, { projection: { agentOverrides: 1 } })
      .toArray(),
    collections.agents.find({ projectDefault: 'disabled' }, { projection: { _id: 1 } }).toArray(),
  ]);
  const notLead = (id: ObjectId) => leadId === null || !leadId.equals(id);
  const filters: Filter<IssueDoc>[] = [];
  const enabledIn = new Map<string, ObjectId[]>();
  for (const project of projects) {
    for (const entry of project.agentOverrides ?? []) {
      if (!entry.enabled && notLead(entry.agentId)) {
        filters.push({ projectId: project._id, assigneeAgentId: entry.agentId });
      } else if (entry.enabled) {
        const key = entry.agentId.toHexString();
        enabledIn.set(key, [...(enabledIn.get(key) ?? []), project._id]);
      }
    }
  }
  for (const agent of defaultOff) {
    if (notLead(agent._id)) {
      const allowed = enabledIn.get(agent._id.toHexString()) ?? [];
      filters.push({ assigneeAgentId: agent._id, projectId: { $nin: allowed } });
    }
  }
  return filters;
}

/** Agents that are not enabled in a project, by name, for the lead's board view. */
export async function agentsNotEnabledIn(
  collections: Collections,
  projectId: ObjectId,
): Promise<{ id: string; name: string }[]> {
  const [{ isEnabled }, agents] = await Promise.all([
    projectAccessChecker(collections, projectId),
    collections.agents
      .find({}, { projection: { name: 1, projectDefault: 1 } })
      .sort({ name: 1 })
      .toArray(),
  ]);
  return agents
    .filter((agent) => !isEnabled(agent))
    .map((agent) => ({ id: agent._id.toHexString(), name: agent.name }));
}
