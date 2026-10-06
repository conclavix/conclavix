import { MarkerType, type Edge, type Node } from '@vue-flow/core';
import type { AgentLink, GraphAgent } from '../api/org-graph';
import { LINK_HANDLES } from './rules';

export interface AgentNodeData {
  agent: GraphAgent;
  lead: boolean;
  connected: boolean;
  running: boolean;
  status: GraphAgent['status'];
  model: string | null;
  editable: boolean;
}

export interface NodeContext {
  leadAgentId: string | null;
  reachable: Set<string>;
  running: Set<string>;
  liveStatus: (id: string) => GraphAgent['status'] | undefined;
  liveModel: (id: string) => string | undefined;
  editable: boolean;
}

/** Build canvas nodes with graph positions, live status fallbacks, and connection permissions. */
export function toNodes(agents: GraphAgent[], context: NodeContext): Node<AgentNodeData>[] {
  return agents.map((agent) => ({
    id: agent.id,
    type: 'agent',
    position: agent.position ?? { x: 0, y: 0 },
    connectable: context.editable,
    deletable: false,
    data: {
      agent,
      lead: agent.id === context.leadAgentId,
      connected: context.reachable.has(agent.id),
      running: context.running.has(agent.id),
      status: context.liveStatus(agent.id) ?? agent.status,
      model: agent.model ?? context.liveModel(agent.id) ?? null,
      editable: context.editable,
    },
  }));
}

export type EdgeColors = Record<AgentLink['type'], string>;

/** Map links to typed handles and themed arrows; pending links remain non-deletable. */
export function toEdges(links: AgentLink[], editable: boolean, colors: EdgeColors): Edge[] {
  return links.map((link) => {
    const [sourceHandle, targetHandle] = LINK_HANDLES[link.type];
    return {
      id: link.id,
      source: link.from,
      target: link.to,
      sourceHandle,
      targetHandle,
      class:
        `edge-${link.type}` +
        (link.type === 'reports' && link.wakeOnReport === true ? ' edge-wakes' : '') +
        (link.id.startsWith('pending-') ? ' edge-pending' : ''),
      deletable: editable && !link.id.startsWith('pending-'),
      markerEnd: { type: MarkerType.ArrowClosed, color: colors[link.type] },
      data: { type: link.type },
      ariaLabel: `${link.type} link${link.wakeOnReport === true ? ' (wakes target)' : ''}`,
    };
  });
}
