import type { Ref } from 'vue';
import { saveLayout, type GraphAgent, type LayoutEntry, type Position } from '../api/org-graph';

export const LAYOUT_SAVE_DELAY_MS = 600;

/** Applies positions locally at once and saves them in debounced batches when editable. */
export function createLayoutQueue(
  agents: Ref<Record<string, GraphAgent>>,
  editable: Ref<boolean>,
  fail: (cause: unknown) => false,
) {
  let inFlight: Promise<boolean> | undefined;
  let pending = new Map<string, Position>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** Update known agents locally without scheduling a server write. */
  function apply(positions: Record<string, Position>): void {
    for (const [id, position] of Object.entries(positions)) {
      const agent = agents.value[id];
      if (agent) agent.position = position;
    }
  }

  /** Save queued batches serially; retain failed positions without replacing newer edits. */
  async function drain(): Promise<boolean> {
    while (pending.size > 0) {
      if (!editable.value) return false;
      const batch: LayoutEntry[] = [...pending].map(([agentId, point]) => ({ agentId, ...point }));
      pending = new Map();
      try {
        await saveLayout(batch);
      } catch (cause) {
        for (const { agentId, x, y } of batch) {
          if (!pending.has(agentId)) pending.set(agentId, { x, y });
        }
        return fail(cause);
      }
    }
    return true;
  }

  /** Cancel debounce and share the active drain; resolve false when positions cannot be saved. */
  function flush(): Promise<boolean> {
    clearTimeout(timer);
    timer = undefined;
    inFlight ??= drain().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  /** Apply positions immediately and debounce persistence only when editing is supported. */
  function move(positions: Record<string, Position>, delay = LAYOUT_SAVE_DELAY_MS): void {
    apply(positions);
    if (!editable.value) return;
    Object.entries(positions).forEach(([id, position]) => pending.set(id, position));
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), delay);
  }

  return { apply, move, flush };
}
