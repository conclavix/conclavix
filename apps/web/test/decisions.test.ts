import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, type Component } from 'vue';
import { createVuetify } from 'vuetify';
import { plainAnswer, type Decision } from '../src/api/decisions';
import { followStream, type StreamHandlers } from '../src/api/stream';
import DecisionsNavItem from '../src/components/DecisionsNavItem.vue';
import { useAuthStore } from '../src/stores/auth';
import { useDecisionsStore, withSettled } from '../src/stores/decisions';
import { useLiveStore } from '../src/stores/live';
import DecisionsView from '../src/views/DecisionsView.vue';

vi.mock('../src/api/stream', () => ({ followStream: vi.fn(() => () => undefined) }));

const decision = (overrides: Partial<Decision> = {}): Decision => ({
  id: 'd1',
  status: 'open',
  question: 'Postgres or Mongo?',
  options: ['Postgres', 'Mongo'],
  askedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
  askedBy: { agentId: 'a1', name: 'Planner' },
  issue: { id: 'i1', key: 'CVX-7', title: 'Pick a database', status: 'in_review' },
  project: { id: 'p1', key: 'CVX', name: 'Conclavix' },
  decidedAt: null,
  decidedBy: null,
  answer: null,
  ...overrides,
});

const json = (body: unknown) => new Response(JSON.stringify(body));

const flush = async () => {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
  }
};

/** A fake board API holding open decisions; answering moves one to the decided list. */
function fakeApi(open: Decision[]) {
  const calls: { url: string; body: unknown }[] = [];
  const decided: Decision[] = [];
  const handler = async (url: string, init: RequestInit = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    if (url === '/api/decisions/count') return json({ open: open.length });
    if (url.startsWith('/api/decisions?status=open')) {
      return json({ items: open, total: open.length });
    }
    if (url.startsWith('/api/decisions?status=decided')) {
      return json({ items: decided, total: decided.length });
    }
    const match = /^\/api\/decisions\/(\w+)\/(answer|dismiss)$/.exec(url);
    if (match) {
      const index = open.findIndex((item) => item.id === match[1]);
      const [settled] = open.splice(index, 1);
      const result = {
        ...settled,
        status: match[2] === 'answer' ? 'answered' : 'dismissed',
        decidedAt: new Date().toISOString(),
        answer: body.option ?? body.reason ?? body.body ?? null,
      };
      decided.unshift(result as Decision);
      return json(result);
    }
    return new Response('{}', { status: 404 });
  };
  return { calls, handler };
}

describe('decisions store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('moves a settled decision from open to recent and lowers the count once', () => {
    const lists = { open: [decision(), decision({ id: 'd2' })], recent: [], openCount: 2 };
    const answered = decision({ status: 'answered', answer: 'Mongo' });
    const next = withSettled(lists, answered);
    expect(next.open.map((item) => item.id)).toEqual(['d2']);
    expect(next.recent).toEqual([answered]);
    expect(next.openCount).toBe(1);
    expect(withSettled(next, answered).openCount).toBe(1);
    expect(withSettled(lists, decision())).toBe(lists);
  });

  it('shows answers as one line of plain text', () => {
    expect(plainAnswer('**Decision:** EU\n\nKeep data local.')).toBe(
      'Decision: EU Keep data local.',
    );
    expect(plainAnswer(null)).toBe('no answer');
  });

  it('follows the count through decision events and reconnects', async () => {
    const api = fakeApi([decision()]);
    const fetchMock = vi.fn(api.handler);
    vi.stubGlobal('fetch', fetchMock);
    const live = useLiveStore();
    live.connect(() => undefined);
    const handlers = vi.mocked(followStream).mock.calls.at(-1)?.[0] as StreamHandlers;
    const store = useDecisionsStore();
    store.start();
    store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.openCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    handlers.onEvent('issue', { id: 'i1' });
    handlers.onEvent('decision', { id: 'd2', status: 'open' });
    handlers.onEvent('decision', { id: 'd2', status: 'open' });
    await vi.advanceTimersByTimeAsync(400);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    handlers.onStatus('connecting');
    handlers.onStatus('live');
    await vi.advanceTimersByTimeAsync(400);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('drops a list response that an answer or a newer refresh overtook', async () => {
    const replies: ((response: Response) => void)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/answer')
          ? json(decision({ status: 'answered', answer: 'Mongo' }))
          : new Promise<Response>((resolve) => replies.push(resolve)),
      ),
    );
    const store = useDecisionsStore();
    const loading = store.retain();
    await vi.advanceTimersByTimeAsync(0);
    await store.answer('d1', { option: 'Mongo' });
    expect(store.recent.map((item) => item.status)).toEqual(['answered']);
    replies.forEach((reply) => reply(json({ items: [decision()], total: 1 })));
    await loading;
    expect(store.open).toEqual([]);
    expect(store.recent.map((item) => item.status)).toEqual(['answered']);
    store.release();
  });
});

// Mounting Vuetify in jsdom is slow on a loaded machine; the default 5 s is too tight.
describe('decisions UI', { timeout: 20_000 }, () => {
  let host: HTMLDivElement;
  let app: ReturnType<typeof createApp>;
  let pinia: Pinia;
  const RouterLink = defineComponent({
    props: { to: { type: Object, required: true } },
    setup:
      (_, { slots }) =>
      () =>
        h('a', { href: '#' }, slots['default']?.()),
  });

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    host = document.createElement('div');
    document.body.append(host);
  });
  afterEach(() => {
    app?.unmount();
    host.remove();
    vi.unstubAllGlobals();
  });

  const mount = (component: Component) => {
    app = createApp(component);
    app.use(pinia).use(createVuetify());
    app.component('RouterLink', RouterLink);
    app.mount(host);
  };
  const badge = () => host.querySelector('[data-test="decisions-badge"] .v-badge__badge');
  const visible = (element: Element | null) =>
    element !== null && (element as HTMLElement).style.display !== 'none';

  it('hides the badge at zero and shows the open count otherwise', async () => {
    vi.stubGlobal('fetch', vi.fn(fakeApi([]).handler));
    mount(defineComponent({ setup: () => () => h('div', [h(DecisionsNavItem)]) }));
    await flush();
    expect(host.textContent).toContain('Decisions');
    expect(visible(badge())).toBe(false);

    useDecisionsStore().openCount = 2;
    await flush();
    expect(visible(badge())).toBe(true);
    expect(badge()?.textContent?.trim()).toBe('2');
    expect(badge()?.getAttribute('aria-label')).toBe('2 open board decisions');
  });

  it('answers with an option, with free text, and dismisses', async () => {
    useAuthStore().me = { kind: 'user', id: 'u1', role: 'member', mfaRequired: false };
    const api = fakeApi([
      decision(),
      decision({ id: 'd2', question: 'Ship it?', options: [] }),
      decision({ id: 'd3', question: 'Rename?', options: [] }),
    ]);
    vi.stubGlobal('fetch', vi.fn(api.handler));
    mount(DecisionsView);
    await flush();
    const cards = () => [...host.querySelectorAll('[data-test="decision-card"]')];
    expect(cards()).toHaveLength(3);
    expect(cards()[0]?.textContent).toContain('CVX-7');
    expect(cards()[0]?.textContent).toContain('Planner');
    expect(cards()[0]?.textContent).toContain('3h');

    const option = [...host.querySelectorAll<HTMLButtonElement>('[data-test="decision-option"]')];
    expect(option.map((button) => button.textContent?.trim())).toEqual(['Postgres', 'Mongo']);
    option[1]?.click();
    await flush();
    expect(api.calls).toContainEqual({
      url: '/api/decisions/d1/answer',
      body: { option: 'Mongo' },
    });
    expect(cards()).toHaveLength(2);

    const send = () => host.querySelector<HTMLButtonElement>('[data-test="decision-send"]');
    expect(send()?.disabled).toBe(true);
    const textarea = host.querySelector<HTMLTextAreaElement>(
      '[data-test="decision-answer"] textarea',
    );
    if (!textarea) throw new Error('answer field missing');
    textarea.value = 'Yes, on Friday.';
    textarea.dispatchEvent(new Event('input'));
    await flush();
    send()?.click();
    await flush();
    expect(api.calls).toContainEqual({
      url: '/api/decisions/d2/answer',
      body: { body: 'Yes, on Friday.' },
    });
    expect(cards()).toHaveLength(1);

    host.querySelector<HTMLButtonElement>('[data-test="decision-dismiss"]')?.click();
    await flush();
    expect(api.calls).toContainEqual({ url: '/api/decisions/d3/dismiss', body: {} });
    expect(host.querySelector('[data-test="decisions-empty"]')).not.toBeNull();
    expect(host.querySelector('[data-test="decisions-recent"]')?.textContent).toContain(
      'Recently decided (3)',
    );
  });

  it('hides the answer controls from viewers', async () => {
    useAuthStore().me = { kind: 'user', id: 'u1', role: 'viewer', mfaRequired: false };
    vi.stubGlobal('fetch', vi.fn(fakeApi([decision()]).handler));
    mount(DecisionsView);
    await flush();
    expect(host.querySelector('[data-test="decision-answer"]')).toBeNull();
    expect(host.querySelector('[data-test="decision-dismiss"]')).toBeNull();
    const buttons = host.querySelectorAll<HTMLButtonElement>('[data-test="decision-option"]');
    expect([...buttons].every((button) => button.disabled)).toBe(true);
  });
});
