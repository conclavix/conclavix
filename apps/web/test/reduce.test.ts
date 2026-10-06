import { describe, expect, it } from 'vitest';
import { applyEvent, emptyState, mergeLog } from '../src/stores/reduce';

describe('live reducer', () => {
  it('upserts runs, keeping fields that a later event does not carry', () => {
    const state = emptyState();
    applyEvent(state, 'run', { id: 'r1', status: 'queued', agentId: 'a1' });
    applyEvent(state, 'run', { id: 'r1', status: 'running' });
    expect(state.runs['r1']).toEqual({ id: 'r1', status: 'running', agentId: 'a1' });
  });

  it('orders log lines by seq and ignores duplicates delivered twice', () => {
    const state = emptyState();
    applyEvent(state, 'run_event', { runId: 'r1', seq: 2, type: 'assistant', text: 'b', at: '' });
    applyEvent(state, 'run_event', { runId: 'r1', seq: 1, type: 'system', text: 'a', at: '' });
    applyEvent(state, 'run_event', { runId: 'r1', seq: 2, type: 'assistant', text: 'b', at: '' });
    expect(state.logs['r1']?.map((line) => line.seq)).toEqual([1, 2]);
  });

  it('merges a fetched log with lines that arrived live', () => {
    const live = [{ seq: 5, type: 'result', text: 'done', at: '' }];
    const fetched = [1, 2, 3, 4, 5].map((seq) => ({ seq, type: 'x', text: String(seq), at: '' }));
    expect(mergeLog(live, fetched).map((line) => line.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('adds each comment once and ignores unknown events', () => {
    const state = emptyState();
    applyEvent(state, 'comment', {
      id: 'c1',
      issueId: 'i1',
      author: { type: 'board' },
      body: 'hi',
    });
    applyEvent(state, 'comment', {
      id: 'c1',
      issueId: 'i1',
      author: { type: 'board' },
      body: 'hi',
    });
    applyEvent(state, 'nonsense', { id: 'x' });
    expect(state.comments).toHaveLength(1);
  });
});
