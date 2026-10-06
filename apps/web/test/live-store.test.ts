import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { followStream } from '../src/api/stream';
import { useLiveStore } from '../src/stores/live';

vi.mock('../src/api/stream', () => ({ followStream: vi.fn() }));

describe('live stream subscriptions', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.resetAllMocks();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('isolates subscriber errors and continues delivering after applying live state', () => {
    const log = vi.fn();
    vi.stubGlobal('reportError', log);
    const store = useLiveStore();
    store.subscribe(() => {
      throw new Error('private error detail');
    });
    const listener = vi.fn(() => expect(store.state.agents['a']?.name).toBe('A'));
    const unsubscribe = store.subscribe(listener);
    store.connect(vi.fn());
    const options = vi.mocked(followStream).mock.calls[0]?.[0];
    if (!options) throw new Error('Stream was not connected');
    const data = { id: 'a', name: 'A' };
    expect(() => options.onEvent('agent', data)).not.toThrow();
    expect(listener).toHaveBeenCalledWith('agent', data);
    expect(log).toHaveBeenCalledWith(new Error('Live stream listener failed for event agent'));
    unsubscribe();
    options.onEvent('agent', data);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
