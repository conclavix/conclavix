import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import { api } from '../api/client';
import { followStream, type StreamStatus } from '../api/stream';
import type { Agent, Issue, Page, Run, RunLogLine } from '../api/types';
import { applyEvent, emptyState, mergeLog } from './reduce';

const ACTIVE = new Set(['queued', 'running']);
const EVENTS_PAGE = 500;

export const isActive = (status: string | undefined): boolean => ACTIVE.has(status ?? '');

export type StreamListener = (type: string, data: Record<string, unknown>) => void;

type LiveState = ReturnType<typeof emptyState>;

/** Fetch every issue matching the query (all pages) into the live state. */
async function fetchIssues(state: LiveState, query: Record<string, string>): Promise<void> {
  let after: string | null | undefined;
  do {
    const params = new URLSearchParams({ ...query, limit: '100', ...(after ? { after } : {}) });
    const page = await api<Page<Issue>>(`/issues?${params.toString()}`);
    page.items.forEach((issue) => applyEvent(state, 'issue', { ...issue }));
    after = page.nextCursor;
  } while (after);
}

/** Fetch all run log pages and merge entries by sequence without duplicating existing lines. */
async function fetchLog(state: LiveState, runId: string): Promise<void> {
  let after = 0;
  for (;;) {
    const page = await api<Page<RunLogLine>>(`/runs/${runId}/events?after=${after}`);
    state.logs[runId] = mergeLog(state.logs[runId] ?? [], page.items);
    const last = page.items.at(-1);
    if (!last || page.items.length < EVENTS_PAGE) return;
    after = last.seq;
  }
}

/** Fetches issues the board has not seen yet, e.g. for old runs in the history. */
function issueLoader(state: LiveState): (ids: string[]) => Promise<void> {
  const pendingIssues = new Set<string>();
  return async (ids) => {
    const missing = [...new Set(ids)].filter((id) => !state.issues[id] && !pendingIssues.has(id));
    missing.forEach((id) => pendingIssues.add(id));
    await Promise.all(
      missing.map(async (id) => {
        try {
          applyEvent(state, 'issue', { ...(await api<Issue>(`/issues/${id}`)) });
        } finally {
          pendingIssues.delete(id);
        }
      }),
    );
  };
}

export const useLiveStore = defineStore('live', () => {
  const state = reactive(emptyState());
  const status = ref<StreamStatus>('offline');
  let stop: (() => void) | null = null;
  const listeners = new Set<StreamListener>();

  const runs = computed(() =>
    Object.values(state.runs).sort((a, b) => (b.id > a.id ? 1 : b.id < a.id ? -1 : 0)),
  );
  const activeRuns = computed(() => runs.value.filter((run) => ACTIVE.has(run.status ?? '')));
  const recentRuns = computed(() =>
    runs.value.filter((run) => !ACTIVE.has(run.status ?? '')).slice(0, 30),
  );

  /** Fetch agents, issues, and recent runs and merge them into the existing live state. */
  async function load(): Promise<void> {
    const [agents, issues, recent, active] = await Promise.all([
      api<Page<Agent>>('/agents'),
      api<Page<Issue>>('/issues?limit=100'),
      api<Page<Run>>('/runs?limit=50'),
      api<Page<Run>>('/runs?status=queued,running&limit=100'),
    ]);
    agents.items.forEach((agent) => applyEvent(state, 'agent', { ...agent }));
    issues.items.forEach((issue) => applyEvent(state, 'issue', { ...issue }));
    [...recent.items, ...active.items].forEach((run) => applyEvent(state, 'run', { ...run }));
  }

  const ensureIssues = issueLoader(state);

  /** Fetch one run (e.g. an old one from the history) and the issue it belongs to. */
  async function loadRun(runId: string): Promise<void> {
    const run = await api<Run>(`/runs/${runId}`);
    applyEvent(state, 'run', { ...run });
    await ensureIssues([run.issueId]);
  }

  /** Replace any existing stream connection and deliver events after updating live state. */
  function connect(onUnauthorized: () => void): void {
    stop?.();
    stop = followStream({
      /** Fold an event into live state and isolate subscriber failures during notification. */
      onEvent: (type, data) => {
        applyEvent(state, type, data);
        listeners.forEach((listener) => {
          try {
            listener(type, data);
          } catch {
            reportError(new Error(`Live stream listener failed for event ${type}`));
          }
        });
      },
      /** Expose the stream connection status to reactive consumers. */
      onStatus: (next) => {
        status.value = next;
      },
      onUnauthorized,
    });
  }

  /** Receive every stream event after the live state has folded it; returns an unsubscribe function. */
  function subscribe(listener: StreamListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** Stop the active stream and mark the store offline without clearing cached data. */
  function disconnect(): void {
    stop?.();
    stop = null;
    status.value = 'offline';
  }

  return {
    state,
    status,
    runs,
    activeRuns,
    recentRuns,
    load,
    loadIssues: (query: Record<string, string> = {}) => fetchIssues(state, query),
    loadLog: (runId: string) => fetchLog(state, runId),
    loadRun,
    ensureIssues,
    connect,
    disconnect,
    subscribe,
  };
});
