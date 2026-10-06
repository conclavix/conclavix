import type { Agent, Comment, Issue, Run, RunLogLine } from '../api/types';

const MAX_LOG_LINES = 2000;
const MAX_COMMENTS = 200;

export interface LiveState {
  agents: Record<string, Partial<Agent> & { id: string }>;
  issues: Record<string, Partial<Issue> & { id: string }>;
  runs: Record<string, Partial<Run> & { id: string }>;
  logs: Record<string, RunLogLine[]>;
  comments: Comment[];
}

export const emptyState = (): LiveState => ({
  agents: {},
  issues: {},
  runs: {},
  logs: {},
  comments: [],
});

/** Insert log lines in seq order without duplicates, keeping the newest MAX_LOG_LINES. */
export function mergeLog(existing: RunLogLine[], incoming: RunLogLine[]): RunLogLine[] {
  const bySeq = new Map(existing.map((line) => [line.seq, line]));
  for (const line of incoming) {
    bySeq.set(line.seq, line);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-MAX_LOG_LINES);
}

type Upsertable = { id: string };

function upsert<T extends Upsertable>(
  table: Record<string, Partial<T> & Upsertable>,
  data: Record<string, unknown>,
): void {
  const id = data['id'];
  if (typeof id !== 'string') {
    return;
  }
  table[id] = { ...table[id], ...(data as Partial<T>), id };
}

/** Fold one stream event into the live state. Unknown events are ignored. */
export function applyEvent(state: LiveState, type: string, data: Record<string, unknown>): void {
  switch (type) {
    case 'agent':
      upsert<Agent>(state.agents, data);
      break;
    case 'issue':
      upsert<Issue>(state.issues, data);
      break;
    case 'run':
      upsert<Run>(state.runs, data);
      break;
    case 'run_event': {
      const runId = data['runId'];
      if (typeof runId === 'string') {
        state.logs[runId] = mergeLog(state.logs[runId] ?? [], [data as unknown as RunLogLine]);
      }
      break;
    }
    case 'comment':
      if (
        typeof data['id'] === 'string' &&
        !state.comments.some((comment) => comment.id === data['id'])
      ) {
        state.comments = [...state.comments, data as unknown as Comment].slice(-MAX_COMMENTS);
      }
      break;
  }
}
