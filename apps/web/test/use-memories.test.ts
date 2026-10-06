import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { tokenStore } from '../src/api/client';
import type { Memory, MemoryBucket } from '../src/api/memory';
import { SEARCH_DELAY_MS, useMemories } from '../src/memory/useMemories';

const memory = (id: string, body = 'body'): Memory => ({
  id,
  scope: 'project',
  projectId: 'p1',
  agentId: null,
  title: `title ${id}`,
  body,
  tags: [],
  author: { type: 'board' },
  revision: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
});

const json = (status: number, body: unknown): Response =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await nextTick();
  await vi.runAllTimersAsync();
};

describe('useMemories', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let scope = effectScope();

  beforeEach(() => {
    scope = effectScope();
    vi.useFakeTimers();
    tokenStore.set('t'.repeat(32));
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    scope.stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const start = (bucket: MemoryBucket | null) => {
    const target = ref<MemoryBucket | null>(bucket);
    const state = scope.run(() => useMemories(target));
    if (!state) throw new Error('scope stopped');
    return { target, state };
  };
  const urls = (): string[] => fetchMock.mock.calls.map(([url]) => String(url));

  it('does not load until a bucket is known, then lists it', async () => {
    fetchMock.mockResolvedValue(json(200, { items: [memory('m1')] }));
    const { target, state } = start(null);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    target.value = { scope: 'project', projectId: 'p1' };
    await flush();
    expect(urls()).toEqual(['/api/memories?scope=project&limit=50&projectId=p1']);
    expect(state.hits.value.map((hit) => hit.memory.id)).toEqual(['m1']);
    expect(state.searched.value).toBe('');
  });

  it('debounces search and keeps only the latest answer', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { items: [] }));
    const { state } = start({ scope: 'global' });
    await flush();
    let answerSlow: (response: Response) => void = () => undefined;
    fetchMock
      .mockReturnValueOnce(new Promise<Response>((resolve) => (answerSlow = resolve)))
      .mockResolvedValueOnce(json(200, { items: [memory('new', 'fact')] }));
    state.search('re');
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY_MS / 2);
    state.search('redis');
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY_MS);
    expect(urls()).toHaveLength(2);
    state.search('redis cache');
    await flush();
    answerSlow(json(200, { items: [memory('stale')] }));
    await flush();
    expect(urls().at(-1)).toContain('q=redis+cache');
    expect(state.hits.value.map((hit) => hit.memory.id)).toEqual(['new']);
    expect(state.searched.value).toBe('redis cache');
  });

  it('shows API errors and clears them after a successful load', async () => {
    fetchMock.mockResolvedValueOnce(json(500, { message: 'hindsight unavailable' }));
    const { state } = start({ scope: 'global' });
    await flush();
    expect(state.error.value).toBe('hindsight unavailable');
    fetchMock.mockResolvedValueOnce(json(200, { items: [] }));
    await state.reload();
    expect(state.error.value).toBe('');
  });

  it('creates in the bucket, patches only changes, and removes locally', async () => {
    fetchMock.mockResolvedValue(json(200, { items: [memory('m1')] }));
    const { state } = start({ scope: 'project', projectId: 'p1' });
    await flush();

    fetchMock.mockResolvedValueOnce(json(201, memory('m2')));
    await state.save(null, { title: 'T', body: 'B', tags: ['x'] });
    const [, createInit] = fetchMock.mock.calls.at(-2) ?? [];
    expect(JSON.parse(String(createInit.body))).toEqual({
      scope: 'project',
      projectId: 'p1',
      title: 'T',
      body: 'B',
      tags: ['x'],
    });

    fetchMock.mockResolvedValueOnce(json(200, memory('m1')));
    await state.save(memory('m1'), { title: 'title m1', body: 'changed', tags: [] });
    const [patchUrl, patchInit] = fetchMock.mock.calls.at(-2) ?? [];
    expect(patchUrl).toBe('/api/memories/m1');
    expect(JSON.parse(String(patchInit.body))).toEqual({ body: 'changed' });

    fetchMock.mockResolvedValueOnce(json(204, null));
    await state.remove(memory('m1'));
    expect(fetchMock.mock.calls.at(-1)?.[1]?.method).toBe('DELETE');
    expect(state.hits.value).toEqual([]);
  });

  it('lets a failed save reach the caller', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { items: [] }));
    const { state } = start({ scope: 'project', projectId: 'p1' });
    await flush();
    fetchMock.mockResolvedValueOnce(json(409, { message: 'title taken' }));
    await expect(state.save(memory('m1'), { title: 'x', body: 'y', tags: [] })).rejects.toThrow(
      'title taken',
    );
  });
  it('clears loading and errors when a bucket is deselected during a request', async () => {
    fetchMock.mockResolvedValueOnce(json(500, { message: 'unavailable' }));
    const { target, state } = start({ scope: 'project', projectId: 'p1' });
    await flush();
    expect(state.error.value).toBe('unavailable');
    let answer!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
    );
    const pending = state.reload();
    expect(state.loading.value).toBe(true);
    target.value = null;
    await nextTick();
    expect(state.loading.value).toBe(false);
    expect(state.error.value).toBe('');
    answer(json(500, { message: 'old error' }));
    await pending;
    expect(state.error.value).toBe('');
    expect(state.hits.value).toEqual([]);
  });

  it('clears old hits before loading another bucket, even when that load fails', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { items: [memory('m1')] }));
    const { target, state } = start({ scope: 'project', projectId: 'p1' });
    await flush();
    let answer!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
    );
    target.value = { scope: 'project', projectId: 'p2' };
    await nextTick();
    expect(state.hits.value).toEqual([]);
    await expect(state.remove(memory('m1'))).rejects.toThrow('selected bucket');
    await expect(state.save(memory('m1'), { title: 'x', body: 'y', tags: [] })).rejects.toThrow(
      'selected bucket',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    answer(json(500, { message: 'p2 unavailable' }));
    await flush();
    expect(state.hits.value).toEqual([]);
    expect(state.error.value).toBe('p2 unavailable');
  });

  it('does not resurrect a deletion from an earlier list response', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { items: [memory('m1'), memory('m2')] }));
    const { state } = start({ scope: 'project', projectId: 'p1' });
    await flush();
    let answer!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
    );
    const pending = state.reload();
    fetchMock.mockResolvedValueOnce(json(204, null));
    await state.remove(memory('m1'));
    expect(state.loading.value).toBe(false);
    answer(json(200, { items: [memory('m1'), memory('m2')] }));
    await pending;
    expect(state.hits.value.map((hit) => hit.memory.id)).toEqual(['m2']);
  });

  it('does not cancel the new bucket load when a previous bucket deletion finishes', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { items: [memory('m1')] }));
    const { target, state } = start({ scope: 'project', projectId: 'p1' });
    await flush();
    let deleted!: (value: Response) => void;
    let listed!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        deleted = resolve;
      }),
    );
    const pending = state.remove(memory('m1'));
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        listed = resolve;
      }),
    );
    target.value = { scope: 'global' };
    await nextTick();
    deleted(json(204, null));
    await pending;
    expect(state.loading.value).toBe(true);
    listed(json(200, { items: [{ ...memory('m2'), scope: 'global', projectId: null }] }));
    await flush();
    expect(state.hits.value.map((hit) => hit.memory.id)).toEqual(['m2']);
  });

  it('does not reload a new bucket when a previous bucket save finishes', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { items: [] }));
    const { target, state } = start({ scope: 'project', projectId: 'p1' });
    await flush();
    let saved!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        saved = resolve;
      }),
    );
    const pending = state.save(null, { title: 'new', body: 'body', tags: [] });
    fetchMock.mockResolvedValueOnce(json(200, { items: [] }));
    target.value = { scope: 'global' };
    await flush();
    saved(json(201, memory('m1')));
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
