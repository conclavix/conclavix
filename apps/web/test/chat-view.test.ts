import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, reactive } from 'vue';
import { createPinia } from 'pinia';
import { createVuetify } from 'vuetify';
import ChatView from '../src/views/ChatView.vue';
import { tokenStore } from '../src/api/client';
import type { Chat, ChatMessage } from '../src/chats/api';

const { auth, live, listeners } = vi.hoisted(() => {
  const listeners: ((type: string, data: Record<string, unknown>) => void)[] = [];
  return {
    listeners,
    auth: { me: { role: 'admin' } as { role: string }, names: {} as Record<string, string> },
    live: {
      state: {
        agents: { a1: { id: 'a1', name: 'Mr. Green' } },
        logs: {} as Record<string, unknown[]>,
      },
      loadLog: vi.fn(async () => undefined),
      subscribe: (listener: (type: string, data: Record<string, unknown>) => void) => {
        listeners.push(listener);
        return () => listeners.splice(listeners.indexOf(listener), 1);
      },
    },
  };
});
vi.mock('../src/stores/auth', () => ({ useAuthStore: () => auth }));
vi.mock('../src/stores/live', () => ({ useLiveStore: () => live }));

const RouterLink = defineComponent({
  props: { to: { type: Object, required: true } },
  setup(props, { slots }) {
    return () => h('a', { 'data-to': JSON.stringify(props.to) }, slots['default']?.());
  },
});

const chat = (overrides: Partial<Chat> = {}): Chat => ({
  id: 'c1',
  title: 'Customer portal',
  status: 'open',
  leadAgentId: 'a1',
  projectId: null,
  plan: {
    revision: 2,
    markdown: '# Goal\nA portal',
    runId: 'r0',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  approval: null,
  created: { projectId: null, projectKey: null, issueId: null, issueKey: null },
  activeRunId: null,
  pendingTurn: null,
  lastError: null,
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

const message = (id: string, role: 'board' | 'agent', content: string): ChatMessage => ({
  id,
  chatId: 'c1',
  role,
  author: role === 'agent' ? { type: 'agent', agentId: 'a1' } : { type: 'board' },
  content,
  runId: role === 'agent' ? `run-${id}` : null,
  error: null,
  createdAt: '2026-01-01T00:00:00Z',
});

const flush = async () => {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
  }
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Mounting Vuetify with dialogs is slow on a busy host; the default 5 s is too tight there.
describe('chat view', { timeout: 20_000 }, () => {
  let app: ReturnType<typeof createApp>;
  let host: HTMLDivElement;
  const fetchMock = vi.fn();
  let current: Chat;
  let messages: ChatMessage[];

  beforeEach(() => {
    auth.me = { role: 'admin' };
    current = chat();
    messages = [message('m1', 'board', 'We need a portal'), message('m2', 'agent', 'For whom?')];
    tokenStore.set('t'.repeat(32));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal('visualViewport', Object.assign(new EventTarget(), { width: 1024, height: 768 }));
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
      if (url === '/api/chats/c1' && !init.method) return json({ chat: current, messages });
      if (url === '/api/chats/c1/messages') {
        const sent = message('m3', 'board', JSON.parse(String(init.body)).content);
        messages = [...messages, sent];
        current = chat({
          pendingTurn: { reason: 'chat', requestedAt: '', notBefore: null, deferReason: null },
        });
        return json({ message: sent, chat: current }, 202);
      }
      if (url === '/api/chats/c1/approve') {
        current = chat({
          status: 'approved',
          approval: { userId: null, at: '2026-01-02T00:00:00Z', planRevision: 2 },
          pendingTurn: {
            reason: 'plan_approved',
            requestedAt: '',
            notBefore: null,
            deferReason: null,
          },
        });
        return json(current);
      }
      return json({ message: `unexpected ${url}` }, 500);
    });
    host = document.createElement('div');
    document.body.append(host);
  });

  afterEach(() => {
    app?.unmount();
    host.remove();
    listeners.length = 0;
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  const route = reactive({ chatId: 'c1' });

  function mount() {
    route.chatId = 'c1';
    app = createApp({ render: () => h(ChatView, { chatId: route.chatId }) });
    app.use(createPinia());
    app.use(createVuetify());
    app.component('RouterLink', RouterLink);
    app.mount(host);
  }

  const button = (test: string) => host.querySelector<HTMLButtonElement>(`[data-test="${test}"]`);

  it('shows the conversation and the plan, sends a message and streams the reply', async () => {
    mount();
    await flush();
    expect(host.textContent).toContain('Customer portal');
    expect(host.textContent).toContain('We need a portal');
    expect(host.textContent).toContain('For whom?');
    expect(host.querySelector('[data-test="plan-revision"]')?.textContent).toContain('revision 2');
    expect(
      host.querySelector('[data-test="reply-run-link"]')?.closest('a')?.dataset['to'],
    ).toContain('run-m2');

    const input = host.querySelector<HTMLTextAreaElement>('[data-test="chat-composer"] textarea');
    if (!input) throw new Error('no composer');
    input.value = 'Our customers';
    input.dispatchEvent(new Event('input'));
    await flush();
    button('chat-send')?.click();
    await flush();
    const posted = fetchMock.mock.calls.find(([url]) => url === '/api/chats/c1/messages');
    expect(JSON.parse(String(posted?.[1]?.body))).toEqual({ content: 'Our customers' });
    expect(host.textContent).toContain('Mr. Green will answer shortly');
    expect(button('chat-send')?.disabled).toBe(true);
    expect(button('approve-plan')?.disabled).toBe(true);

    listeners.forEach((listener) =>
      listener('chat_message', { ...message('m4', 'agent', 'Then a self-service portal.') }),
    );
    await flush();
    expect(host.textContent).toContain('Then a self-service portal.');
  });

  it('approves the plan revision the board sees and shows the created links', async () => {
    mount();
    await flush();
    button('approve-plan')?.click();
    await flush();
    document.querySelector<HTMLButtonElement>('[data-test="approve-confirm"]')?.click();
    await flush();
    const approved = fetchMock.mock.calls.find(([url]) => url === '/api/chats/c1/approve');
    expect(JSON.parse(String(approved?.[1]?.body))).toEqual({ planRevision: 2 });
    expect(host.querySelector('[data-test="approval"]')?.textContent).toContain('Revision 2');

    current = chat({
      status: 'approved',
      approval: { userId: null, at: '2026-01-02T00:00:00Z', planRevision: 2 },
      created: { projectId: 'p1', projectKey: 'PORT', issueId: 'i1', issueKey: 'PORT-1' },
    });
    listeners.forEach((listener) => listener('chat', { ...current }));
    await flush();
    expect(host.querySelector('[data-test="created-project"]')?.textContent).toContain('PORT');
    expect(host.querySelector('[data-test="created-issue"]')?.textContent).toContain('PORT-1');
  });

  it('drops the outcome of a request for a chat the view has left', async () => {
    let refuse: (response: Response) => void = () => undefined;
    const base = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
      if (url === '/api/chats/c1/messages') return new Promise<Response>((done) => (refuse = done));
      if (url === '/api/chats/c2') {
        return json({ chat: chat({ id: 'c2', title: 'Second chat', plan: null }), messages: [] });
      }
      return base?.(url, init);
    });
    mount();
    await flush();
    const input = host.querySelector<HTMLTextAreaElement>('[data-test="chat-composer"] textarea');
    if (!input) throw new Error('no composer');
    input.value = 'For c1';
    input.dispatchEvent(new Event('input'));
    await flush();
    button('chat-send')?.click();
    await flush();
    route.chatId = 'c2';
    await flush();
    refuse(json({ message: 'the lead is still answering' }, 409));
    await flush();
    expect(host.textContent).toContain('Second chat');
    expect(host.textContent).not.toContain('the lead is still answering');
    const fresh = host.querySelector<HTMLTextAreaElement>('[data-test="chat-composer"] textarea');
    expect(fresh?.value).toBe('');
    expect(button('chat-send')?.querySelector('.v-progress-circular')).toBeNull();
  });

  it('is read-only for viewers', async () => {
    auth.me = { role: 'viewer' };
    mount();
    await flush();
    expect(host.textContent).toContain('Read-only');
    expect(button('chat-send')?.disabled).toBe(true);
    expect(button('approve-plan')?.disabled).toBe(true);
    expect(host.textContent).toContain('Only admins and owners approve plans.');
  });
});
