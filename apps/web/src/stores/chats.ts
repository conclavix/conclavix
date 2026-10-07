import { defineStore } from 'pinia';
import { computed, ref, type Ref } from 'vue';
import { chatApi, type Chat, type ChatMessage } from '../chats/api';
import { mergeMessage } from '../chats/logic';

const newestFirst = (a: Chat, b: Chat): number => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** The list with `chat` added, or merged into its entry (stream updates carry fewer fields). */
function withChat(items: readonly Chat[], chat: Chat): Chat[] {
  const index = items.findIndex((item) => item.id === chat.id);
  if (index === -1) return [...items, chat];
  return items.map((item) => (item.id === chat.id ? { ...item, ...chat } : item));
}

interface OpenChat {
  current: Ref<Chat | null>;
  messages: Ref<ChatMessage[]>;
  upsert(chat: Chat): void;
  refresh(): Promise<void>;
}

/** What the board does in the open chat: write to the lead, approve its plan, archive. */
function chatActions({ current, messages, upsert, refresh }: OpenChat) {
  return {
    async post(content: string): Promise<void> {
      const id = current.value?.id;
      if (!id) return;
      const { message, chat } = await chatApi.post(id, content);
      // The view may have moved to another chat meanwhile; the list still gets the update.
      if (current.value?.id === id) messages.value = mergeMessage(messages.value, message);
      upsert(chat);
    },
    async approve(planRevision: number): Promise<void> {
      if (!current.value) return;
      upsert(await chatApi.approve(current.value.id, planRevision));
      await refresh();
    },
    async archive(): Promise<void> {
      if (!current.value) return;
      upsert(await chatApi.archive(current.value.id));
    },
  };
}

/** Chats with the lead: the list, and the one chat that is open in the view. */
export const useChatsStore = defineStore('chats', () => {
  const items = ref<Chat[]>([]);
  const loaded = ref(false);
  const current = ref<Chat | null>(null);
  const messages = ref<ChatMessage[]>([]);
  /** Why reloading the open chat failed; the view shows it until a reload works. */
  const loadError = ref('');
  /** The chat the view asked for last; answers for any other chat are dropped. */
  let wanted: string | null = null;

  const sorted = computed(() => [...items.value].sort(newestFirst));

  function upsert(chat: Chat): void {
    items.value = withChat(items.value, chat);
    if (current.value?.id === chat.id) current.value = { ...current.value, ...chat };
  }

  async function load(): Promise<void> {
    items.value = (await chatApi.list()).items;
    loaded.value = true;
  }

  async function open(id: string): Promise<void> {
    wanted = id;
    const result = await chatApi.get(id);
    if (wanted !== id) return;
    current.value = result.chat;
    messages.value = result.messages;
    loadError.value = '';
    upsert(result.chat);
  }

  /** Reload the open chat, e.g. after the stream reported a change of it. */
  async function refresh(): Promise<void> {
    if (current.value) await open(current.value.id);
  }

  /** A reload triggered by the stream: a failure is kept for the view instead of thrown. */
  async function refreshQuietly(): Promise<void> {
    const id = current.value?.id;
    try {
      await refresh();
    } catch (cause) {
      if (wanted === id) loadError.value = `Could not reload the chat: ${messageOf(cause)}`;
    }
  }

  async function create(title: string, projectId: string | null): Promise<Chat> {
    const chat = await chatApi.create({ title, projectId });
    upsert(chat);
    return chat;
  }

  /**
   * Fold a stream event in: chat changes update the list (and reload the open chat, whose read
   * carries the created project and issue), new messages of the open chat are appended.
   */
  function applyStream(type: string, data: Record<string, unknown>): void {
    if (type === 'chat' && typeof data['id'] === 'string') {
      upsert(data as unknown as Chat);
      if (current.value?.id === data['id']) void refreshQuietly();
    } else if (type === 'chat_message' && current.value?.id === data['chatId']) {
      messages.value = mergeMessage(messages.value, data as unknown as ChatMessage);
    }
  }

  function close(): void {
    wanted = null;
    current.value = null;
    messages.value = [];
    loadError.value = '';
  }

  return {
    items,
    sorted,
    loaded,
    current,
    messages,
    loadError,
    load,
    open,
    refresh,
    create,
    ...chatActions({ current, messages, upsert, refresh }),
    applyStream,
    close,
  };
});
