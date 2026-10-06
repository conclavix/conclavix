import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { useOverviewStore } from '../src/stores/overview';

vi.mock('../src/api/client', () => ({ api: vi.fn() }));

const deferred = () => Promise.withResolvers<Record<string, unknown>>();

describe('overview refresh coordination', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    vi.mocked(api).mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each(['success', 'failure'])(
    'coalesces overlaps after %s into one follow-up',
    async (outcome) => {
      const first = deferred();
      const second = deferred();
      vi.mocked(api).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const store = useOverviewStore();
      store.retain();
      const pending = store.refresh();
      let settled = false;
      void store.refresh().then(() => {
        settled = true;
      });
      expect(api).toHaveBeenCalledTimes(1);

      if (outcome === 'success') first.resolve({});
      else first.reject(new Error('request failed'));
      await pending;
      await Promise.resolve();
      expect(settled).toBe(true);
      expect(api).toHaveBeenCalledTimes(2);

      second.resolve({});
      await vi.advanceTimersByTimeAsync(0);
      expect(api).toHaveBeenCalledTimes(2);
      store.release();
    },
  );

  it('drops the follow-up after release and clears the overlap flag', async () => {
    const first = deferred();
    vi.mocked(api).mockReturnValueOnce(first.promise).mockResolvedValue({});
    const store = useOverviewStore();
    store.retain();
    const pending = store.refresh();
    store.release();
    first.resolve({});
    await pending;
    expect(api).toHaveBeenCalledTimes(1);

    store.retain();
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(2);
    store.release();
  });

  it('allows another follow-up when calls overlap the retry', async () => {
    const first = deferred();
    const second = deferred();
    vi.mocked(api)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue({});
    const store = useOverviewStore();
    store.retain();
    const pending = store.refresh();
    first.resolve({});
    await pending;
    const retry = store.refresh();
    second.resolve({});
    await retry;
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(3);
    store.release();
  });
});
