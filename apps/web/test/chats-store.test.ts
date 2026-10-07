import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { Chat } from '../src/chats/api';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../src/chats/api', () => ({ chatApi: { get } }));
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
});
