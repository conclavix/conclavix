import { api, ApiError } from './client';
import type { OrgNode } from './types';
import {
  agentLinkSchema,
  orgGraphSchema,
  orgChartSchema,
  orgInfoSchema,
  parseOrgResponse,
} from './org-schemas';

export type LinkType = 'delegates' | 'reports';

export interface Position {
  x: number;
  y: number;
}

export interface GraphAgent {
  id: string;
  name: string;
  role: string;
  title: string;
  status: 'active' | 'paused';
  avatarUrl?: string | null;
  adapterType?: string;
  model: string | null;
  position: Position | null;
}

export interface AgentLink {
  id: string;
  from: string;
  to: string;
  type: LinkType;
  /** Reports links: the target is woken, not only notified, when delegated work closes. */
  wakeOnReport?: boolean;
  createdAt?: string;
}

export interface AgentSummary {
  id: string;
  name: string;
  role: string;
  title: string;
}

export interface OrgInfo {
  leadAgentId: string | null;
  lead: AgentSummary | null;
  leadCandidates: AgentSummary[];
}

export interface OrgGraph {
  leadAgentId: string | null;
  agents: GraphAgent[];
  links: AgentLink[];
}

export interface LoadedGraph {
  graph: OrgGraph;
  /** False when the server only offers the legacy org chart; the graph is then derived and read-only. */
  editable: boolean;
}

export interface LayoutEntry {
  agentId: string;
  x: number;
  y: number;
}

/** Recognize HTTP 404 errors that allow compatibility fallback or idempotent deletion. */
const isNotFound = (cause: unknown): boolean => cause instanceof ApiError && cause.status === 404;

/**
 * Derive a read-only graph from the legacy `{roots}` org chart: every reporting line M -> A becomes
 * a delegation M -> A plus a report A -> M. A single root is taken as the lead.
 */
export function deriveGraph(roots: OrgNode[]): OrgGraph {
  const agents: GraphAgent[] = [];
  const links: AgentLink[] = [];
  /** Append an agent and both relationship directions, then traverse its direct reports. */
  const visit = (node: OrgNode, manager: string | null): void => {
    agents.push({
      id: node.id,
      name: node.name,
      role: node.role,
      title: node.title,
      status: node.status,
      avatarUrl: node.avatarUrl,
      model: null,
      position: null,
    });
    if (manager !== null) {
      links.push({
        id: `delegates:${manager}:${node.id}`,
        from: manager,
        to: node.id,
        type: 'delegates',
      });
      links.push({
        id: `reports:${node.id}:${manager}`,
        from: node.id,
        to: manager,
        type: 'reports',
      });
    }
    (node.reports ?? []).forEach((child) => visit(child, node.id));
  };
  roots.forEach((root) => visit(root, null));
  return { leadAgentId: roots.length === 1 ? (roots[0]?.id ?? null) : null, agents, links };
}

/** Load the agent graph, falling back to the legacy org chart when `/org-graph` does not exist. */
export async function fetchOrgGraph(): Promise<LoadedGraph> {
  try {
    return {
      graph: parseOrgResponse(orgGraphSchema, await api<unknown>('/org-graph'), '/org-graph'),
      editable: true,
    };
  } catch (cause) {
    if (!isNotFound(cause)) throw cause;
  }
  const chart = parseOrgResponse(orgChartSchema, await api<unknown>('/org-chart'), '/org-chart');
  return { graph: deriveGraph(chart.roots), editable: false };
}

/** The org settings, or null when the server predates the lead-agent API. */
export async function fetchOrg(): Promise<OrgInfo | null> {
  try {
    return parseOrgResponse(orgInfoSchema, await api<unknown>('/org'), '/org');
  } catch (cause) {
    if (isNotFound(cause)) return null;
    throw cause;
  }
}

/** Create a relationship and validate the saved link before optimistic state reconciliation. */
export const createLink = async (link: Omit<AgentLink, 'id'>): Promise<AgentLink> =>
  parseOrgResponse(
    agentLinkSchema,
    await api<unknown>('/agent-links', { method: 'POST', body: JSON.stringify(link) }),
    '/agent-links',
  );

/** Change whether a reports link wakes its target; returns the saved link. */
export const updateLink = async (id: string, wakeOnReport: boolean): Promise<AgentLink> =>
  parseOrgResponse(
    agentLinkSchema,
    await api<unknown>(`/agent-links/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ wakeOnReport }),
    }),
    '/agent-links',
  );

/** Send a mutation whose response body is unused; propagate transport and API errors. */
const send = async (path: string, init: RequestInit): Promise<void> => {
  await api<unknown>(path, init);
};

/** Delete a link; a 404 means it is already gone and counts as success. */
export async function deleteLink(id: string): Promise<void> {
  try {
    await send(`/agent-links/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (cause) {
    if (!isNotFound(cause)) throw cause;
  }
}

export const MAX_COORDINATE = 1_000_000;
export const MAX_LAYOUT_BATCH = 500;

/** Round a coordinate to an integer within the layout API range. */
const clamp = (value: number): number =>
  Math.min(MAX_COORDINATE, Math.max(-MAX_COORDINATE, Math.round(value)));

/** Save positions clamped to the server's coordinate range, in batches it accepts. */
export async function saveLayout(positions: LayoutEntry[]): Promise<void> {
  for (let start = 0; start < positions.length; start += MAX_LAYOUT_BATCH) {
    const batch = positions
      .slice(start, start + MAX_LAYOUT_BATCH)
      .map(({ agentId, x, y }) => ({ agentId, x: clamp(x), y: clamp(y) }));
    await send('/org/layout', { method: 'PUT', body: JSON.stringify({ positions: batch }) });
  }
}

/** Request a lead change; callers reload the graph to obtain the resulting state. */
export const setLead = (agentId: string): Promise<void> =>
  send('/org/lead', { method: 'PUT', body: JSON.stringify({ agentId }) });

/** Persist an agent status change without updating local state before success. */
export const setAgentStatus = (id: string, status: GraphAgent['status']): Promise<void> =>
  send(`/agents/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status }) });
