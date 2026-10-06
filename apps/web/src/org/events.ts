import type { Ref } from 'vue';
import { graphAgentSchema } from '../api/org-schemas';
import type { AgentLink, GraphAgent, LinkType, Position } from '../api/org-graph';

export interface GraphRefs {
  agents: Ref<Record<string, GraphAgent>>;
  links: Ref<AgentLink[]>;
  leadAgentId: Ref<string | null>;
}

const LINK_TYPES: readonly string[] = ['delegates', 'reports'];
const REMOVED = /delet|remov/i;
const agentPatchSchema = graphAgentSchema
  .pick({ name: true, role: true, title: true, status: true, model: true, position: true })
  .partial();

/** Narrow stream values to non-null objects while excluding arrays. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Extract a link with string endpoints and a supported type, or return null. */
function asLink(value: unknown): AgentLink | null {
  if (!isRecord(value)) return null;
  const { id, from, to, type, wakeOnReport } = value;
  if (typeof id !== 'string' || typeof from !== 'string' || typeof to !== 'string') return null;
  if (typeof type !== 'string' || !LINK_TYPES.includes(type)) return null;
  return {
    id,
    from,
    to,
    type: type as LinkType,
    ...(typeof wakeOnReport === 'boolean' ? { wakeOnReport } : {}),
  };
}

/** Remove or upsert a streamed link, replacing matching optimistic entries on upsert. */
function applyLink(refs: GraphRefs, event: string, data: Record<string, unknown>): boolean {
  const body = isRecord(data['link']) ? data['link'] : data;
  if (REMOVED.test(event) || data['deleted'] === true) {
    const id = body['id'] ?? data['linkId'];
    if (typeof id !== 'string') return false;
    refs.links.value = refs.links.value.filter((link) => link.id !== id);
    return true;
  }
  const link = asLink(body);
  if (!link) return false;
  const others = refs.links.value.filter(
    (item) =>
      item.id !== link.id &&
      !(
        item.id.startsWith('pending-') &&
        item.from === link.from &&
        item.to === link.to &&
        item.type === link.type
      ),
  );
  refs.links.value = [...others, link];
  return true;
}

/** Apply numeric positions to known agents; ignore deletion notifications and invalid entries. */
function applyLayout(refs: GraphRefs, data: Record<string, unknown>): boolean {
  if (data['deleted'] === true) return true;
  const positions = Array.isArray(data['positions']) ? data['positions'] : [data];
  for (const entry of positions) {
    if (!isRecord(entry)) continue;
    const agent = refs.agents.value[String(entry['agentId'])];
    const { x, y } = entry;
    if (agent && typeof x === 'number' && typeof y === 'number') {
      agent.position = { x, y } satisfies Position;
    }
  }
  return true;
}

/** Update the lead from a supported event ID field; return false for an invalid ID. */
function applyLead(refs: GraphRefs, data: Record<string, unknown>): boolean {
  const id = data['leadAgentId'] ?? data['agentId'];
  if (id !== null && typeof id !== 'string') return false;
  refs.leadAgentId.value = id;
  return true;
}

/** Validate a partial patch before updating a known agent, including legacy adapter models. */
function applyAgent(refs: GraphRefs, data: Record<string, unknown>): boolean {
  const agent = typeof data['id'] === 'string' ? refs.agents.value[data['id']] : undefined;
  if (!agent) return false;
  const parsed = agentPatchSchema.safeParse(data);
  if (!parsed.success) return false;
  const patch = Object.fromEntries(
    Object.entries(parsed.data).filter(([, value]) => value !== undefined),
  );
  if (isRecord(data['adapter']) && typeof data['adapter']['model'] === 'string') {
    patch['model'] = data['adapter']['model'];
  }
  Object.assign(agent, patch);
  return true;
}

/**
 * Fold a stream event into the graph: `agent_link`, `org_layout`, `org` and `agent`, also matching
 * close variants of those names. Returns false when the event is not recognised.
 */
export function applyGraphEvent(
  refs: GraphRefs,
  event: string,
  data: Record<string, unknown>,
): boolean {
  if (/link/i.test(event)) return applyLink(refs, event, data);
  if (/layout/i.test(event)) return applyLayout(refs, data);
  if (event === 'org' || /lead/i.test(event)) return applyLead(refs, data);
  if (event === 'agent') return applyAgent(refs, data);
  return false;
}
