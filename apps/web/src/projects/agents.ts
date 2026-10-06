import { api } from '../api/client';
import type { Page, ProjectAgent } from '../api/types';

export const loadProjectAgents = async (projectId: string): Promise<ProjectAgent[]> =>
  (await api<Page<ProjectAgent>>(`/projects/${projectId}/agents`)).items;

/** Set (true/false) or remove (null) the project's override for an agent. */
export const setProjectAgent = (
  projectId: string,
  agentId: string,
  enabled: boolean | null,
): Promise<ProjectAgent> =>
  api<ProjectAgent>(`/projects/${projectId}/agents/${agentId}`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  });

export const NOT_ENABLED_HINT = 'Not enabled in this project; enable it on the Agents tab';

/** The chip text that says where an agent's state in the project comes from. */
export function sourceLabel(agent: ProjectAgent): string {
  if (agent.isLead) return 'lead · always on';
  if (agent.source === 'project') return 'project override';
  return `agent default (${agent.projectDefault === 'enabled' ? 'on' : 'off'})`;
}

/**
 * What flipping the switch does: the override to store, and whether to ask first. Choosing what
 * the agent default already says stores no override, so the agent follows later default changes.
 */
export function toggleIntent(
  agent: ProjectAgent,
  enabled: boolean,
): { override: boolean | null; confirm: string | null } {
  const defaultEnabled = agent.projectDefault === 'enabled';
  const override = enabled === defaultEnabled ? null : enabled;
  if (enabled || agent.openIssues === 0) return { override, confirm: null };
  const issues = agent.openIssues === 1 ? '1 open issue' : `${agent.openIssues} open issues`;
  return {
    override,
    confirm:
      `${agent.name} has ${issues} in this project. They stay assigned but are not worked on ` +
      'while the agent is disabled here. Reassign them or enable the agent again later.',
  };
}

/** Agent ids not enabled in the project, for marking existing assignments on the board. */
export function disabledAgentIds(agents: readonly ProjectAgent[]): Set<string> {
  return new Set(agents.filter((agent) => !agent.enabled).map((agent) => agent.id));
}

export interface AssigneeOption {
  id: string;
  name: string;
  subtitle: string;
  disabled: boolean;
}

/**
 * Assignee picker entries. With project access known, agents not enabled there are disabled,
 * except the current assignee, which stays selectable so the field keeps showing it.
 */
export function assigneeOptions(
  agents: readonly { id: string; name: string; role: string; status: string }[],
  access: readonly ProjectAgent[] | null,
  current: string | null,
): AssigneeOption[] {
  const enabled = access ? new Map(access.map((agent) => [agent.id, agent.enabled])) : null;
  return agents.map((agent) => {
    const off = enabled !== null && enabled.get(agent.id) === false;
    return {
      id: agent.id,
      name: agent.name,
      subtitle: off
        ? `${agent.role} · not enabled in this project`
        : `${agent.role} · ${agent.status}`,
      disabled: off && agent.id !== current,
    };
  });
}
