<script setup lang="ts">
import { mdiAccountOutline, mdiOpenInNew, mdiRobotOutline } from '@mdi/js';
import { computed, nextTick, ref, watch } from 'vue';
import type { RunLogLine } from '../../api/types';
import type { ChatMessage } from '../../chats/api';
import { buildRunView } from '../../stores/run-view';
import { useAuthStore } from '../../stores/auth';
import MarkdownBlock from '../MarkdownBlock.vue';
import RunChat from '../RunChat.vue';

const props = defineProps<{
  messages: ChatMessage[];
  leadName: string;
  /** The run answering right now and its log so far, streamed live. */
  activeRunId: string | null;
  liveLines: RunLogLine[];
}>();

const auth = useAuthStore();
const box = ref<HTMLElement | null>(null);

/** The answering run's messages and tool calls; system and runner lines stay in the run log. */
const liveItems = computed(() =>
  buildRunView(props.liveLines).items.filter(
    (item) => item.kind === 'message' || item.kind === 'tool' || item.kind === 'thinking',
  ),
);

const author = (message: ChatMessage): string => {
  if (message.role === 'agent') return props.leadName;
  if (message.author.type === 'user') {
    return auth.names[message.author.userId] ?? 'board member';
  }
  return 'Board';
};

const time = (iso: string): string => new Date(iso).toLocaleString();

watch(
  () => [props.messages.length, props.liveLines.length],
  async () => {
    await nextTick();
    if (box.value) box.value.scrollTop = box.value.scrollHeight;
  },
  { immediate: true },
);
</script>

<template>
  <div ref="box" class="chat-thread" data-test="chat-thread">
    <div
      v-for="message in messages"
      :key="message.id"
      class="chat-thread__row"
      :class="{ 'chat-thread__row--board': message.role === 'board' }"
      :data-role="message.role"
    >
      <v-avatar
        size="28"
        :color="message.role === 'agent' ? 'primary' : 'secondary'"
        variant="tonal"
        class="chat-thread__avatar"
      >
        <v-icon :icon="message.role === 'agent' ? mdiRobotOutline : mdiAccountOutline" size="18" />
      </v-avatar>
      <v-card
        rounded="lg"
        class="chat-thread__bubble"
        :variant="message.role === 'agent' ? 'flat' : 'tonal'"
        :color="message.role === 'agent' ? 'surface-light' : 'primary'"
      >
        <div class="text-caption text-medium-emphasis mb-1">
          {{ author(message) }} · {{ time(message.createdAt) }}
        </div>
        <MarkdownBlock v-if="message.content.trim()" :source="message.content" />
        <div v-else-if="!message.error" class="text-medium-emphasis">No reply.</div>
        <v-alert
          v-if="message.error"
          type="error"
          variant="tonal"
          density="compact"
          class="mt-1"
          data-test="reply-error"
        >
          No reply: {{ message.error }}
        </v-alert>
        <div v-if="message.runId" class="text-right mt-1">
          <router-link
            :to="{ name: 'run', params: { runId: message.runId } }"
            class="text-caption"
            data-test="reply-run-link"
          >
            <v-icon :icon="mdiOpenInNew" size="12" /> run log
          </router-link>
        </div>
      </v-card>
    </div>
    <div v-if="activeRunId" class="chat-thread__live" data-test="live-reply">
      <div class="text-caption text-medium-emphasis px-4">
        {{ leadName }} is answering ·
        <router-link :to="{ name: 'run', params: { runId: activeRunId } }">live run</router-link>
      </div>
      <RunChat v-if="liveItems.length > 0" :items="liveItems" :live="true" />
      <v-progress-linear indeterminate color="primary" class="mx-4" style="width: auto" />
    </div>
    <div v-if="messages.length === 0 && !activeRunId" class="text-medium-emphasis pa-6 text-center">
      Describe what you want to achieve; {{ leadName }} asks questions and drafts a plan.
    </div>
  </div>
</template>

<style scoped>
.chat-thread {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 8px;
  overflow-y: auto;
  min-height: 0;
  flex: 1 1 auto;
}
.chat-thread__row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.chat-thread__row--board {
  flex-direction: row-reverse;
}
.chat-thread__avatar {
  flex: 0 0 auto;
  margin-top: 2px;
}
.chat-thread__bubble {
  max-width: min(760px, 85%);
  min-width: 0;
  padding: 8px 12px;
  overflow-wrap: anywhere;
}
</style>
