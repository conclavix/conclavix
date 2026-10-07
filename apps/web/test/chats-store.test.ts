import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { Chat } from '../src/chats/api';

const { get, post, list } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), list: vi.fn() }));
vi.mock('../src/chats/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/chats/api')>()),
  chatApi: { get, post, list },
}));
const { useChatsStore } = await import('../src/stores/chats');

const chat = (id: string): Chat => ({
  id,
  title: id,
  status: 'open',
  leadAgentId: 'a1',
  projectId: null,
  plan: null,
  approval: null,
  activeRunId: null,
  pendingTurn: null,
  lastError: null,
  updatedAt: '2026-01-01T00:00:00Z',
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('chats store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    get.mockReset();
    post.mockReset();
  });

  it('keeps the answer to a message out of a chat the view moved to', async () => {
    get.mockImplementation(async (id: string) => ({ chat: chat(id), messages: [] }));
    let answer: (value: unknown) => void = () => undefined;
    post.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const store = useChatsStore();
    await store.open('a');
    const sending = store.post('Hello');
    await store.open('b');
    answer({
      message: {
        id: 'm1',
        chatId: 'a',
        role: 'board',
        author: { type: 'board' },
        content: 'Hello',
        runId: null,
        error: null,
        createdAt: '2026-01-01T00:00:00Z',
      },
      chat: {
        ...chat('a'),
        pendingTurn: { reason: 'chat', requestedAt: '', notBefore: null, deferReason: null },
      },
    });
    await sending;
    expect(store.current?.id).toBe('b');
    expect(store.messages).toEqual([]);
    expect(store.items.find((item) => item.id === 'a')?.pendingTurn).not.toBeNull();
  });

  it('drops an answer for a chat the view has moved away from', async () => {
    let answerA: (value: unknown) => void = () => undefined;
    get.mockImplementation((id: string) =>
      id === 'a'
        ? new Promise((resolve) => (answerA = resolve))
        : Promise.resolve({ chat: chat('b'), messages: [] }),
    );
    const store = useChatsStore();
    const first = store.open('a');
    await store.open('b');
    answerA({ chat: chat('a'), messages: [] });
    await first;
    expect(store.current?.id).toBe('b');
  });

  it('keeps a failed stream-triggered reload for the view', async () => {
    get.mockResolvedValueOnce({ chat: chat('a'), messages: [] });
    const store = useChatsStore();
    await store.open('a');
    get.mockRejectedValueOnce(new Error('offline'));
    store.applyStream('chat', { ...chat('a'), title: 'renamed' });
    await flush();
    expect(store.loadError).toContain('offline');
    get.mockResolvedValueOnce({ chat: chat('a'), messages: [] });
    store.applyStream('chat', { ...chat('a') });
    await flush();
    expect(store.loadError).toBe('');
  });

  it('ignores malformed stream events', async () => {
    get.mockResolvedValueOnce({ chat: chat('a'), messages: [] });
    const store = useChatsStore();
    await store.open('a');
    store.applyStream('chat_message', { id: 'm1', chatId: 'a', content: 42 });
    store.applyStream('chat', { id: 'a', status: 'deleted' });
    expect(store.messages).toEqual([]);
    expect(store.current?.status).toBe('open');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('keeps the newest chat list when an older request answers last', async () => {
    let older: (value: unknown) => void = () => undefined;
    list
      .mockReturnValueOnce(new Promise((resolve) => (older = resolve)))
      .mockResolvedValueOnce({ items: [chat('archived-too')] });
    const store = useChatsStore();
    const first = store.load(false);
    await store.load(true);
    older({ items: [chat('open-only')] });
    await first;
    expect(store.items.map((item) => item.id)).toEqual(['archived-too']);
  });
});
