import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { chatApi, type Chat, type ChatMessage } from '../chats/api';
import { mergeMessage } from '../chats/logic';

/** Chats with the lead: the list, and the one chat that is open in the view. */
export const useChatsStore = defineStore('chats', () => {
  const items = ref<Chat[]>([]);
  const loaded = ref(false);
  const current = ref<Chat | null>(null);
  const messages = ref<ChatMessage[]>([]);

  const sorted = computed(() =>
    [...items.value].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)),
  );

  function upsert(chat: Chat): void {
    const index = items.value.findIndex((item) => item.id === chat.id);
    const merged = index === -1 ? chat : { ...items.value[index], ...chat };
    items.value =
      index === -1
        ? [...items.value, merged]
        : items.value.map((item) => (item.id === chat.id ? merged : item));
    if (current.value?.id === chat.id) current.value = { ...current.value, ...chat };
  }

  async function load(): Promise<void> {
    items.value = (await chatApi.list()).items;
    loaded.value = true;
  }

  async function open(id: string): Promise<void> {
    const result = await chatApi.get(id);
    current.value = result.chat;
    messages.value = result.messages;
    upsert(result.chat);
  }

  /** Reload the open chat, e.g. after the stream reported a change of it. */
  async function refresh(): Promise<void> {
    if (current.value) await open(current.value.id);
  }

  async function create(title: string, projectId: string | null): Promise<Chat> {
    const chat = await chatApi.create({ title, projectId });
    upsert(chat);
    return chat;
  }

  async function post(content: string): Promise<void> {
    if (!current.value) return;
    const { message, chat } = await chatApi.post(current.value.id, content);
    messages.value = mergeMessage(messages.value, message);
    upsert(chat);
  }

  async function approve(planRevision: number): Promise<void> {
    if (!current.value) return;
    upsert(await chatApi.approve(current.value.id, planRevision));
    await refresh();
  }

  async function archive(): Promise<void> {
    if (!current.value) return;
    upsert(await chatApi.archive(current.value.id));
  }

  /**
   * Fold a stream event in: chat changes update the list (and reload the open chat, whose read
   * carries the created project and issue), new messages of the open chat are appended.
   */
  function applyStream(type: string, data: Record<string, unknown>): void {
    if (type === 'chat' && typeof data['id'] === 'string') {
      upsert(data as unknown as Chat);
      if (current.value?.id === data['id']) void refresh().catch(() => undefined);
    } else if (type === 'chat_message' && current.value?.id === data['chatId']) {
      messages.value = mergeMessage(messages.value, data as unknown as ChatMessage);
    }
  }

  function close(): void {
    current.value = null;
    messages.value = [];
  }

  return {
    items,
    sorted,
    loaded,
    current,
    messages,
    load,
    open,
    refresh,
    create,
    post,
    approve,
    archive,
    applyStream,
    close,
  };
});
