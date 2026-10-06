import { defineStore } from 'pinia';
import { computed, ref, watch, type WatchStopHandle } from 'vue';
import { api } from '../api/client';
import type { Overview } from '../api/overview';
import { useLiveStore } from './live';

const REFRESH_MS = 30_000;
const THROTTLE_MS = 5_000;

export const useOverviewStore = defineStore('overview', () => {
  const live = useLiveStore();
  const data = ref<Overview | null>(null);
  const error = ref<string | null>(null);
  const loadedAt = ref<number | null>(null);
  let inFlight: Promise<void> | null = null;
  let refreshAgain = false;
  let users = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let stopWatch: WatchStopHandle | undefined;

  const signature = computed(() =>
    [
      ...Object.values(live.state.runs).map((run) => `${run.id}:${run.status}:${run.costUsd}`),
      ...Object.values(live.state.agents).map((agent) => `${agent.id}:${agent.status}`),
      ...Object.values(live.state.issues).map((issue) => `${issue.id}:${issue.status}`),
      live.state.comments.length,
    ].join('|'),
  );

  async function fetchOnce(): Promise<void> {
    try {
      data.value = await api<Overview>('/overview?days=14');
      error.value = null;
      loadedAt.value = Date.now();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }

  function refresh(): Promise<void> {
    if (inFlight) {
      refreshAgain = true;
      return inFlight;
    }
    inFlight = fetchOnce().finally(() => {
      inFlight = null;
      const retry = refreshAgain;
      refreshAgain = false;
      if (retry && users > 0) void refresh();
    });
    return inFlight;
  }

  function refreshSoon(): void {
    if (pending) return;
    const since = Date.now() - (loadedAt.value ?? 0);
    pending = setTimeout(
      () => {
        pending = undefined;
        void refresh();
      },
      Math.max(0, THROTTLE_MS - since),
    );
  }

  /** Start polling and stream-driven refreshes; pair every call with release(). */
  function retain(): void {
    users += 1;
    if (users > 1) return;
    void refresh();
    timer = setInterval(() => void refresh(), REFRESH_MS);
    stopWatch = watch(signature, refreshSoon);
  }

  function release(): void {
    users = Math.max(0, users - 1);
    if (users > 0) return;
    clearInterval(timer);
    clearTimeout(pending);
    pending = undefined;
    stopWatch?.();
  }

  return { data, error, loadedAt, refresh, retain, release };
});
