import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { ApiError } from '../api/client';
import {
  fetchOrgGraph,
  fetchOrg,
  setAgentStatus,
  setLead,
  type AgentLink,
  type AgentSummary,
  type GraphAgent,
  type Position,
} from '../api/org-graph';
import { applyGraphEvent } from '../org/events';
import { autoArrange, placeMissing } from '../org/layout';
import { createLayoutQueue } from '../org/layout-queue';
import { createLinkActions } from '../org/link-actions';
import { reachableFromLead } from '../org/rules';

export interface Notice {
  text: string;
  color: 'error' | 'success' | 'info';
}

/** Translate duplicate-link errors and other failure values into notice text. */
const messageOf = (cause: unknown): string => {
  if (cause instanceof ApiError && cause.status === 409) return 'This link already exists.';
  return cause instanceof Error ? cause.message : String(cause);
};

/** Report org settings failures while allowing the graph to load without lead controls. */
async function fetchOrgOrReportError(fail: (cause: unknown) => false) {
  try {
    return await fetchOrg();
  } catch (cause) {
    fail(cause);
    return null;
  }
}

export const useOrgGraphStore = defineStore('orgGraph', () => {
  const agents = ref<Record<string, GraphAgent>>({});
  const links = ref<AgentLink[]>([]);
  const leadAgentId = ref<string | null>(null);
  const editable = ref(false);
  const leadSupported = ref(false);
  const leadCandidates = ref<AgentSummary[]>([]);
  const loaded = ref(false);
  const notice = ref<Notice | null>(null);

  const agentList = computed(() => Object.values(agents.value));
  const reachable = computed(() =>
    reachableFromLead({ leadAgentId: leadAgentId.value, links: links.value }),
  );

  /** Publish an error notice and return false for callers using boolean action results. */
  const fail = (cause: unknown): false => {
    notice.value = { text: messageOf(cause), color: 'error' };
    return false;
  };
  const layout = createLayoutQueue(agents, editable, fail);
  const linkActions = createLinkActions({ links, leadAgentId, editable }, fail);

  /** Drain unsaved positions before reloading the graph; reject if persistence fails. */
  async function load(): Promise<void> {
    if (!(await layout.flush())) {
      throw new Error('Could not save the current layout before reloading');
    }
    const [{ graph, editable: canEdit }, org] = await Promise.all([
      fetchOrgGraph(),
      fetchOrgOrReportError(fail),
    ]);
    agents.value = Object.fromEntries(graph.agents.map((agent) => [agent.id, { ...agent }]));
    links.value = graph.links;
    leadAgentId.value = graph.leadAgentId;
    editable.value = canEdit;
    leadSupported.value = org !== null;
    leadCandidates.value = org?.leadCandidates ?? [];
    loaded.value = true;
    const missing = placeMissing(graph.agents, graph.links);
    if (Object.keys(missing).length > 0) layout.move(missing, 0);
  }

  /** Compute positions for every agent and flush the resulting layout immediately. */
  async function arrangeAll(): Promise<boolean> {
    layout.move(autoArrange(agentList.value, links.value), 0);
    return layout.flush();
  }

  /** Run a mutation and convert rejected promises into an error notice and false result. */
  const attempt = async (work: () => Promise<void>): Promise<boolean> => {
    try {
      await work();
      return true;
    } catch (cause) {
      return fail(cause);
    }
  };

  /** Change the lead and reload the graph when the server supports lead editing. */
  const makeLead = async (id: string): Promise<boolean> =>
    leadSupported.value && attempt(() => setLead(id).then(load));

  /** Persist a status change and update the local agent only after the request succeeds. */
  const setStatus = (id: string, status: GraphAgent['status']): Promise<boolean> =>
    attempt(async () => {
      await setAgentStatus(id, status);
      const agent = agents.value[id];
      if (agent) agent.status = status;
    });

  return {
    agents,
    links,
    leadAgentId,
    editable,
    leadSupported,
    leadCandidates,
    loaded,
    notice,
    agentList,
    reachable,
    load,
    ...linkActions,
    /** Apply dragged positions and schedule a debounced layout save. */
    moveAgents: (positions: Record<string, Position>) => layout.move(positions),
    flushLayout: layout.flush,
    arrangeAll,
    makeLead,
    setStatus,
    /** Fold supported organization stream events into graph state and report recognition. */
    applyEvent: (type: string, data: Record<string, unknown>): boolean =>
      applyGraphEvent({ agents, links, leadAgentId }, type, data),
  };
});
