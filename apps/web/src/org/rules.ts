import type { AgentLink, LinkType } from '../api/org-graph';

export const HANDLES = {
  delegationIn: 'delegation-in',
  delegatesOut: 'delegates-out',
  reportsIn: 'reports-in',
  reportsOut: 'reports-out',
} as const;

export type HandleId = (typeof HANDLES)[keyof typeof HANDLES];

export interface ConnectionLike {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export interface GraphView {
  leadAgentId: string | null;
  links: AgentLink[];
}

export type ConnectionCheck =
  { ok: true; link: Omit<AgentLink, 'id'> } | { ok: false; reason: string };

/** The handle pair each link type uses: [source handle, target handle]. */
export const LINK_HANDLES: Record<LinkType, [HandleId, HandleId]> = {
  delegates: [HANDLES.delegatesOut, HANDLES.delegationIn],
  reports: [HANDLES.reportsOut, HANDLES.reportsIn],
};

/** Resolve a supported source/target handle pair to its link type, or return null. */
export function linkTypeFor(
  sourceHandle: string | null | undefined,
  targetHandle: string | null | undefined,
): LinkType | null {
  for (const [type, [out, into]] of Object.entries(LINK_HANDLES) as [
    LinkType,
    [HandleId, HandleId],
  ][]) {
    if (sourceHandle === out && targetHandle === into) return type;
  }
  return null;
}

/** True when `to` can already reach `from` through delegation, so from -> to would close a cycle. */
export function delegationReaches(links: AgentLink[], start: string, goal: string): boolean {
  const next = new Map<string, string[]>();
  for (const link of links) {
    if (link.type !== 'delegates') continue;
    next.set(link.from, [...(next.get(link.from) ?? []), link.to]);
  }
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (id === goal) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(next.get(id) ?? []));
  }
  return false;
}

/** Client-side mirror of the server's link rules; the server stays authoritative. */
export function checkConnection(graph: GraphView, connection: ConnectionLike): ConnectionCheck {
  const type = linkTypeFor(connection.sourceHandle, connection.targetHandle);
  if (type === null) {
    return { ok: false, reason: 'connect delegation to delegation and reports to reports' };
  }
  const { source: from, target: to } = connection;
  if (from === to) return { ok: false, reason: 'an agent cannot link to itself' };
  if (graph.links.some((link) => link.from === from && link.to === to && link.type === type)) {
    return { ok: false, reason: 'this link already exists' };
  }
  if (type === 'delegates') {
    if (to === graph.leadAgentId)
      return { ok: false, reason: 'the lead does not receive delegation' };
    if (delegationReaches(graph.links, to, from)) {
      return { ok: false, reason: 'delegation would form a cycle' };
    }
  }
  return { ok: true, link: { from, to, type } };
}

/** Agents reachable from the lead by following delegation links, including the lead itself. */
export function reachableFromLead(graph: GraphView): Set<string> {
  const reached = new Set<string>();
  if (graph.leadAgentId === null) return reached;
  const stack = [graph.leadAgentId];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const link of graph.links) {
      if (link.type === 'delegates' && link.from === id) stack.push(link.to);
    }
  }
  return reached;
}
