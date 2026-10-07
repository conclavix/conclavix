<script setup lang="ts">
import { mdiArchiveArrowDownOutline, mdiArrowLeft } from '@mdi/js';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
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
    loading.value = true;
    error.value = '';
    try {
      await chats.open(id);
    } catch (cause) {
      error.value = describeError(cause);
    } finally {
      loading.value = false;
    }
  },
  { immediate: true },
);

// Load what the answering run logged before the view opened; the stream adds the rest.
watch(
  activeRunId,
  (runId) => {
    if (runId) void live.loadLog(runId).catch(() => undefined);
  },
  { immediate: true },
);

async function send(content: string): Promise<void> {
  sending.value = true;
  error.value = '';
  try {
    await chats.post(content);
    draft.value = '';
  } catch (cause) {
    error.value = describeError(cause);
  } finally {
    sending.value = false;
  }
}

async function approve(revision: number): Promise<void> {
  approving.value = true;
  error.value = '';
  try {
    await chats.approve(revision);
  } catch (cause) {
    error.value = describeError(cause);
    await chats.refresh().catch(() => undefined);
  } finally {
    approving.value = false;
  }
}

async function archive(): Promise<void> {
  error.value = '';
  try {
    await chats.archive();
  } catch (cause) {
    error.value = describeError(cause);
  }
}
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
