import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createApp,
  h,
  nextTick,
  reactive,
  type Component,
  type ComponentPublicInstance,
} from 'vue';
import type { Page, Run } from '../src/api/types';
import RunDetailView from '../src/views/RunDetailView.vue';
import RunsView from '../src/views/RunsView.vue';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  loadRun: vi.fn(),
  loadLog: vi.fn(),
  ensureIssues: vi.fn(),
}));
vi.mock('../src/api/client', () => ({ api: mocks.api }));
vi.mock('../src/stores/live', () => ({
  useLiveStore: () => ({ ...mocks, state: { runs: {}, logs: {}, agents: {}, issues: {} } }),
  isActive: () => false,
}));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const unmounts: (() => void)[] = [];
function mountState<T>(component: Component, props = {}) {
  // Run the real setup/watchers without mounting the unrelated presentation components.
  const view = { ...component, render: () => null };
  let state!: T;
  const app = createApp({
    render: () =>
      h(view, {
        ...props,
        ref: (instance: ComponentPublicInstance | null) => {
          if (instance) state = (instance.$ as typeof instance.$ & { setupState: T }).setupState;
        },
      }),
  });
  app.mount(document.createElement('div'));
  unmounts.push(() => app.unmount());
  return state;
}
async function settle() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.loadRun.mockResolvedValue(undefined);
  mocks.loadLog.mockResolvedValue(undefined);
  mocks.ensureIssues.mockResolvedValue(undefined);
});
afterEach(() => {
  unmounts.splice(0).forEach((unmount) => unmount());
});

describe('run detail requests', () => {
  it.each(['loadRun', 'loadLog'] as const)(
    'ignores a stale %s failure after navigation',
    async (method) => {
      const old = deferred<undefined>();
      mocks[method].mockImplementation((id: string) =>
        id === 'old' ? old.promise : Promise.resolve(),
      );
      const props = reactive({ runId: 'old' });
      const state = mountState<{ error: string | null }>(RunDetailView, props);
      await settle();
      props.runId = 'new';
      await settle();
      old.reject(new Error('old failed'));
      await settle();
      expect(state.error).toBeNull();
    },
  );

  it.each(['loadRun', 'loadLog'] as const)('keeps a current %s failure visible', async (method) => {
    mocks[method].mockRejectedValue(new Error('current failed'));
    const state = mountState<{ error: string | null }>(RunDetailView, { runId: 'current' });
    await settle();
    expect(state.error).toBe('current failed');
  });
});

interface ListState {
  page: Page<Run>;
  loading: boolean;
  error: string | null;
  filters: { statuses: string[] };
  next: () => void;
  previous: () => void;
}
const page = (id: string): Page<Run> => ({
  items: [{ id, issueId: `issue-${id}` } as Run],
  nextCursor: `cursor-${id}`,
});

describe('runs list requests', () => {
  it('keeps the latest filter page when an older response arrives last', async () => {
    const old = deferred<Page<Run>>();
    const current = deferred<Page<Run>>();
    mocks.api.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const state = mountState<ListState>(RunsView);
    state.filters.statuses = ['failed'];
    await nextTick();
    current.resolve(page('current'));
    await settle();
    old.resolve(page('old'));
    await settle();
    expect(state.page).toEqual(page('current'));
    expect(mocks.ensureIssues).toHaveBeenCalledExactlyOnceWith(['issue-current']);
    expect(state.loading).toBe(false);
  });

  it.each(['success', 'failure'])(
    'keeps loading when an older request finishes with %s',
    async (outcome) => {
      const old = deferred<Page<Run>>();
      const current = deferred<Page<Run>>();
      mocks.api.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
      const state = mountState<ListState>(RunsView);
      state.filters.statuses = ['running'];
      await nextTick();
      if (outcome === 'success') old.resolve(page('old'));
      else old.reject(new Error('old failed'));
      await settle();
      expect(state.loading).toBe(true);
      expect(state.error).toBeNull();
      expect(state.page.items).toEqual([]);
      current.reject('current failed');
      await settle();
      expect(state.error).toBe('current failed');
      expect(state.loading).toBe(false);
    },
  );

  it('ignores an earlier pagination response', async () => {
    const next = deferred<Page<Run>>();
    const previous = deferred<Page<Run>>();
    mocks.api
      .mockResolvedValueOnce(page('first'))
      .mockReturnValueOnce(next.promise)
      .mockReturnValueOnce(previous.promise);
    const state = mountState<ListState>(RunsView);
    await settle();
    state.next();
    state.previous();
    previous.resolve(page('first'));
    await settle();
    next.resolve(page('second'));
    await settle();
    expect(state.page).toEqual(page('first'));
  });

  it('ignores stale issue-loading failures and preserves current ones', async () => {
    const oldIssues = deferred<undefined>();
    const currentIssues = deferred<undefined>();
    mocks.api.mockResolvedValueOnce(page('old')).mockResolvedValueOnce(page('current'));
    mocks.ensureIssues
      .mockReturnValueOnce(oldIssues.promise)
      .mockReturnValueOnce(currentIssues.promise);
    const state = mountState<ListState>(RunsView);
    await settle();
    state.filters.statuses = ['failed'];
    await settle();
    currentIssues.reject(new Error('current issue failed'));
    await settle();
    expect(state.error).toBe('could not load issue keys: current issue failed');
    oldIssues.reject(new Error('old issue failed'));
    await settle();
    expect(state.error).toBe('could not load issue keys: current issue failed');
  });
});
