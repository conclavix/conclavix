import { defineStore } from 'pinia';
import { reactive, ref, toRefs, watch } from 'vue';
import { AuthError } from '../api/client';
import { decisionsApi, type Decision, type DecisionAnswer } from '../api/decisions';
import { describeError } from '../issues';
import { useLiveStore } from './live';

/** Coalesce bursts of stream events (one answer writes the decision and the issue). */
const DEBOUNCE_MS = 300;
const RECENT_LIMIT = 20;

interface DecisionLists {
  open: Decision[];
  recent: Decision[];
  openCount: number;
}

/** The lists after the board settled `decision`: out of open, on top of recent. */
export function withSettled(lists: DecisionLists, decision: Decision): DecisionLists {
  const others = (items: Decision[]) => items.filter((item) => item.id !== decision.id);
  if (decision.status === 'open') {
    return lists;
  }
  const wasOpen = lists.open.some((item) => item.id === decision.id);
  return {
    open: others(lists.open),
    recent: [decision, ...others(lists.recent)].slice(0, RECENT_LIMIT),
    openCount: wasOpen ? Math.max(0, lists.openCount - 1) : lists.openCount,
  };
}

/**
 * Open board decisions: the count for the navigation badge, kept current through `decision`
 * stream events and on every reconnect, and the lists for the Decisions page while it is open.
 */
export const useDecisionsStore = defineStore('decisions', () => {
  const live = useLiveStore();
  const lists = reactive<DecisionLists>({ open: [], recent: [], openCount: 0 });
  const loaded = ref(false);
  const error = ref('');
  let started = false;
  let viewers = 0;
  let pending: ReturnType<typeof setTimeout> | undefined;
  /** Bumped by every refresh and local change; a response for an older value is dropped. */
  let generation = 0;

  async function refreshCount(): Promise<void> {
    const mine = ++generation;
    try {
      const { open } = await decisionsApi.count();
      if (mine === generation) lists.openCount = open;
    } catch (cause) {
      // Keep the last count; the next event or reconnect retries. A lost session is handled by
      // the stream's sign-out, so only other failures are reported.
      if (!(cause instanceof AuthError)) reportError(cause);
    }
  }

  async function refreshLists(): Promise<void> {
    const mine = ++generation;
    try {
      const [open, recent] = await Promise.all([
        decisionsApi.list('open'),
        decisionsApi.list('decided', RECENT_LIMIT),
      ]);
      if (mine !== generation) return;
      Object.assign(lists, { open: open.items, recent: recent.items, openCount: open.total });
      error.value = '';
    } catch (cause) {
      error.value = describeError(cause);
    } finally {
      loaded.value = true;
    }
  }

  function refreshSoon(): void {
    clearTimeout(pending);
    pending = setTimeout(() => {
      pending = undefined;
      void (viewers > 0 ? refreshLists() : refreshCount());
    }, DEBOUNCE_MS);
  }

  /** Follow the open count for the badge; safe to call more than once. */
  function start(): void {
    if (started) return;
    started = true;
    void refreshCount();
    live.subscribe((type) => {
      if (type === 'decision') refreshSoon();
    });
    // Events missed while the stream was down are caught up when it is live again.
    watch(
      () => live.status,
      (status, before) => {
        if (status === 'live' && before !== 'live') refreshSoon();
      },
    );
  }

  /** Load and follow the lists while a page shows them; pair with release(). */
  function retain(): Promise<void> {
    viewers += 1;
    return refreshLists();
  }

  function release(): void {
    viewers = Math.max(0, viewers - 1);
  }

  /** Show a settled decision right away; the stream event then reloads the lists. */
  function settled(decision: Decision): void {
    generation += 1;
    Object.assign(lists, withSettled(lists, decision));
    refreshSoon();
  }

  return {
    ...toRefs(lists),
    loaded,
    error,
    start,
    retain,
    release,
    answer: async (id: string, input: DecisionAnswer) =>
      settled(await decisionsApi.answer(id, input)),
    dismiss: async (id: string, reason?: string) => settled(await decisionsApi.dismiss(id, reason)),
  };
});
