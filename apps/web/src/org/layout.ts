import dagre from '@dagrejs/dagre';
import type { AgentLink, GraphAgent, Position } from '../api/org-graph';

export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 112;
const GAP = 48;

/** Layered left-to-right layout over delegation links only; returns top-left positions per agent. */
export function autoArrange(agents: GraphAgent[], links: AgentLink[]): Record<string, Position> {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: 'LR', nodesep: GAP, ranksep: GAP * 2, marginx: 0, marginy: 0 });
  graph.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(agents.map((agent) => agent.id));
  for (const agent of agents) {
    graph.setNode(agent.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const link of links) {
    if (link.type === 'delegates' && ids.has(link.from) && ids.has(link.to)) {
      graph.setEdge(link.from, link.to);
    }
  }
  dagre.layout(graph);
  const result: Record<string, Position> = {};
  for (const agent of agents) {
    const node = graph.node(agent.id);
    result[agent.id] = {
      x: Math.round(node.x - NODE_WIDTH / 2),
      y: Math.round(node.y - NODE_HEIGHT / 2),
    };
  }
  return result;
}

/**
 * Positions for agents without one: the full layout when nothing is placed, otherwise the layout
 * of the unplaced agents below the placed ones.
 */
export function placeMissing(agents: GraphAgent[], links: AgentLink[]): Record<string, Position> {
  const missing = agents.filter((agent) => agent.position === null);
  if (missing.length === 0) return {};
  const placed = agents.flatMap((agent) => (agent.position ? [agent.position] : []));
  const computed = autoArrange(missing, links);
  if (placed.length === 0) return computed;
  const left = Math.min(...placed.map((point) => point.x));
  const bottom = Math.max(...placed.map((point) => point.y)) + NODE_HEIGHT + GAP * 2;
  const minX = Math.min(...Object.values(computed).map((point) => point.x));
  const minY = Math.min(...Object.values(computed).map((point) => point.y));
  return Object.fromEntries(
    Object.entries(computed).map(([id, point]) => [
      id,
      { x: point.x - minX + left, y: point.y - minY + bottom },
    ]),
  );
}
