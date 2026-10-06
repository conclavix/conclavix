import type { Ref } from 'vue';
import { createLink, deleteLink, updateLink, type AgentLink } from '../api/org-graph';
import { checkConnection, type ConnectionLike } from './rules';

export interface LinkState {
  links: Ref<AgentLink[]>;
  leadAgentId: Ref<string | null>;
  editable: Ref<boolean>;
}

export const PENDING_PREFIX = 'pending-';
/** Identify temporary optimistic links that cannot yet be removed from the server. */
export const isPending = (id: string): boolean => id.startsWith(PENDING_PREFIX);

/** Optimistic link add/remove that reverts and reports through `fail` when rejected. */
export function createLinkActions(state: LinkState, fail: (cause: unknown) => false) {
  let tempSeq = 0;

  /** Validate and add an optimistic link, reconcile its saved identity, or roll back on failure. */
  async function connect(connection: ConnectionLike): Promise<boolean> {
    if (!state.editable.value) return false;
    const check = checkConnection(
      { leadAgentId: state.leadAgentId.value, links: state.links.value },
      connection,
    );
    if (!check.ok) return fail(new Error(check.reason));
    tempSeq += 1;
    const temp: AgentLink = { id: `${PENDING_PREFIX}${tempSeq}`, ...check.link };
    state.links.value = [...state.links.value, temp];
    try {
      const saved = await createLink(check.link);
      const rest = state.links.value.filter((link) => link.id !== saved.id && link.id !== temp.id);
      state.links.value = [...rest, saved];
      return true;
    } catch (cause) {
      state.links.value = state.links.value.filter((link) => link.id !== temp.id);
      return fail(cause);
    }
  }

  /** Remove a persisted link optimistically and restore its prior position if deletion fails. */
  async function removeLink(id: string): Promise<boolean> {
    const index = state.links.value.findIndex((link) => link.id === id);
    const link = state.links.value[index];
    if (!state.editable.value || !link || isPending(link.id)) return false;
    state.links.value = state.links.value.filter((item) => item.id !== id);
    try {
      await deleteLink(id);
      return true;
    } catch (cause) {
      const restored = state.links.value.filter((item) => item.id !== id);
      restored.splice(Math.min(index, restored.length), 0, link);
      state.links.value = restored;
      return fail(cause);
    }
  }

  /** Toggle wakeOnReport on a saved reports link optimistically; restore the old value on failure. */
  async function setWakeOnReport(id: string, wakeOnReport: boolean): Promise<boolean> {
    const link = state.links.value.find((item) => item.id === id);
    if (!state.editable.value || !link || link.type !== 'reports' || isPending(link.id)) {
      return false;
    }
    const previous = link.wakeOnReport === true;
    const replace = (value: AgentLink) => {
      state.links.value = state.links.value.map((item) => (item.id === id ? value : item));
    };
    replace({ ...link, wakeOnReport });
    try {
      replace(await updateLink(id, wakeOnReport));
      return true;
    } catch (cause) {
      const current = state.links.value.find((item) => item.id === id);
      if (current) replace({ ...current, wakeOnReport: previous });
      return fail(cause);
    }
  }

  return { connect, removeLink, setWakeOnReport };
}
