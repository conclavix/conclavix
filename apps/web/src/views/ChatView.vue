<script setup lang="ts">
import { mdiArchiveArrowDownOutline, mdiArrowLeft } from '@mdi/js';
import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { CHAT_STATUS_COLORS, acceptsMessages, canChat, isBusy, turnStatus } from '../chats/logic';
import ChatComposer from '../components/chats/ChatComposer.vue';
import ChatPlanPanel from '../components/chats/ChatPlanPanel.vue';
import ChatThread from '../components/chats/ChatThread.vue';
import { describeError } from '../issues';
import { useAuthStore } from '../stores/auth';
import { useChatsStore } from '../stores/chats';
import { useLiveStore } from '../stores/live';

const props = defineProps<{ chatId: string }>();

const chats = useChatsStore();
const live = useLiveStore();
const auth = useAuthStore();
const error = ref('');
const draft = ref('');
const sending = ref(false);
const approving = ref(false);
const loading = ref(true);

const chat = computed(() => (chats.current?.id === props.chatId ? chats.current : null));
const leadName = computed(
  () => (chat.value && live.state.agents[chat.value.leadAgentId]?.name) || 'The lead',
);
const mayChat = computed(() => canChat(auth.me?.role));
const status = computed(() => (chat.value ? turnStatus(chat.value, leadName.value) : null));
const composerDisabled = computed(
  () => !chat.value || !mayChat.value || !acceptsMessages(chat.value) || isBusy(chat.value),
);
const composerHint = computed(() => {
  if (!chat.value) return null;
  if (!mayChat.value) return 'Read-only: admins and owners plan with the lead.';
  if (!acceptsMessages(chat.value)) {
    return chat.value.status === 'archived'
      ? 'The chat is archived.'
      : 'The approved plan was carried out; start a new chat for the next plan.';
  }
  return status.value;
});
const activeRunId = computed(() => chat.value?.activeRunId ?? null);
const liveLines = computed(() =>
  activeRunId.value ? (live.state.logs[activeRunId.value] ?? []) : [],
);

const stop = live.subscribe((type, data) => chats.applyStream(type, data));
onBeforeUnmount(() => {
  stop();
  chats.close();
});

watch(
  () => props.chatId,
  async (id) => {
    // A new chat starts clean; requests still running for the previous one are dropped below.
    draft.value = '';
    sending.value = false;
    approving.value = false;
    loading.value = true;
    error.value = '';
    try {
      await chats.open(id);
    } catch (cause) {
      if (props.chatId === id) error.value = describeError(cause);
    } finally {
      if (props.chatId === id) loading.value = false;
    }
  },
  { immediate: true },
);

// Load what the answering run logged before the view opened; the stream adds the rest.
watch(
  activeRunId,
  (runId) => {
    if (!runId) return;
    live.loadLog(runId).catch(() => {
      if (activeRunId.value === runId) {
        error.value = 'Could not load what the lead wrote so far; new lines still arrive.';
      }
    });
  },
  { immediate: true },
);

/**
 * Run a request for the open chat. Its outcome (error text, busy flag, follow-up) is dropped once
 * the route moved on to another chat.
 */
async function act(
  busy: Ref<boolean> | null,
  work: (stillHere: () => boolean) => Promise<void>,
  onError?: () => Promise<void>,
): Promise<void> {
  const id = props.chatId;
  const stillHere = (): boolean => props.chatId === id;
  if (busy) busy.value = true;
  error.value = '';
  try {
    await work(stillHere);
  } catch (cause) {
    if (stillHere()) {
      error.value = describeError(cause);
      await onError?.();
    }
  } finally {
    if (busy && stillHere()) busy.value = false;
  }
}

const send = (content: string): Promise<void> =>
  act(sending, async (stillHere) => {
    await chats.post(content);
    if (stillHere()) draft.value = '';
  });

// A refused approval usually means the chat changed: reload it so the panel shows why.
const approve = (revision: number): Promise<void> =>
  act(approving, () => chats.approve(revision), chats.refreshQuietly);

const archive = (): Promise<void> => act(null, () => chats.archive());
</script>

<template>
  <v-container fluid class="pa-3 chat-view">
    <div class="d-flex align-center flex-wrap ga-2 mb-2">
      <v-btn :icon="mdiArrowLeft" variant="text" :to="{ name: 'chats' }" aria-label="All chats" />
      <template v-if="chat">
        <span class="text-h6" data-test="chat-title">{{ chat.title }}</span>
        <v-chip :color="CHAT_STATUS_COLORS[chat.status]" size="small">{{ chat.status }}</v-chip>
        <span class="text-body-2 text-medium-emphasis">with {{ leadName }}</span>
        <v-spacer />
        <v-btn
          v-if="mayChat && chat.status !== 'archived'"
          :prepend-icon="mdiArchiveArrowDownOutline"
          variant="text"
          :disabled="chat.activeRunId !== null"
          @click="archive"
        >
          Archive
        </v-btn>
      </template>
    </div>
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-2">
      {{ error }}
    </v-alert>
    <v-alert v-if="chats.loadError" type="warning" variant="tonal" density="compact" class="mb-2">
      {{ chats.loadError }}
    </v-alert>
    <v-alert
      v-if="chat?.lastError"
      type="warning"
      variant="tonal"
      density="compact"
      class="mb-2"
      data-test="turn-error"
    >
      The last message got no reply: {{ chat.lastError }}
    </v-alert>
    <v-progress-linear v-if="loading && !chat" indeterminate />
    <v-row v-if="chat" density="compact">
      <v-col cols="12" md="7" lg="8">
        <v-card class="chat-view__conversation">
          <ChatThread
            :messages="chats.messages"
            :lead-name="leadName"
            :active-run-id="activeRunId"
            :live-lines="liveLines"
          />
          <v-divider />
          <ChatComposer
            v-model="draft"
            :disabled="composerDisabled"
            :sending="sending"
            :hint="composerHint"
            @send="send"
          />
        </v-card>
      </v-col>
      <v-col cols="12" md="5" lg="4">
        <ChatPlanPanel
          :chat="chat"
          :lead-name="leadName"
          :approving="approving"
          @approve="approve"
        />
      </v-col>
    </v-row>
  </v-container>
</template>

<style scoped>
.chat-view__conversation {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 170px);
  min-height: 420px;
}
</style>
