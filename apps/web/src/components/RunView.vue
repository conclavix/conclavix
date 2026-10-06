<script setup lang="ts">
import { mdiArrowDown } from '@mdi/js';
import { computed, nextTick, ref, watch } from 'vue';
import type { RunLogLine } from '../api/types';
import { issueRepoContext, provideRepoContext } from '../repo-context';
import { useLiveStore } from '../stores/live';
import { FILTER_TABS, buildRunView, itemsForTab, type RunTab } from '../stores/run-view';
import RunChat from './RunChat.vue';

const props = defineProps<{
  runId: string;
  lines: RunLogLine[];
  live: boolean;
  height?: string;
}>();

const liveStore = useLiveStore();
provideRepoContext(() => {
  const issueId = liveStore.state.runs[props.runId]?.issueId;
  return issueRepoContext(issueId ? liveStore.state.issues[issueId] : undefined);
});

const tab = ref<RunTab>('chat');
const box = ref<HTMLElement | null>(null);
const follow = ref(true);

const view = computed(() => buildRunView(props.lines));
const shown = computed(() => itemsForTab(view.value.items, tab.value));

const scrollToEnd = async (): Promise<void> => {
  await nextTick();
  box.value?.scrollTo({ top: box.value.scrollHeight });
};

function jumpToLatest(): void {
  follow.value = true;
  void scrollToEnd();
}

function onScroll(): void {
  const el = box.value;
  if (el) follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

watch(
  () => props.lines.at(-1)?.seq,
  () => {
    if (follow.value) void scrollToEnd();
  },
);
watch(tab, () => {
  follow.value = true;
  void scrollToEnd();
});
watch(
  () => props.runId,
  () => jumpToLatest(),
  { immediate: true },
);
</script>

<template>
  <div class="run-view">
    <v-tabs v-model="tab" density="compact" show-arrows class="run-view__tabs">
      <v-tab value="chat">Chat</v-tab>
      <v-tab v-for="filter in FILTER_TABS" :key="filter.value" :value="filter.value">
        {{ filter.title }}
        <v-chip size="x-small" class="ml-2" :color="tab === filter.value ? 'primary' : undefined">
          {{ view.counts[filter.value] }}
        </v-chip>
      </v-tab>
    </v-tabs>
    <v-divider />
    <div class="run-view__body">
      <div
        ref="box"
        class="run-view__scroll"
        :style="{ height: height ?? 'calc(100vh - 220px)' }"
        @scroll="onScroll"
      >
        <div v-if="tab === 'runner'" class="run-view__lines">
          <div
            v-for="item in shown"
            :key="item.key"
            class="run-view__line"
            :class="item.kind === 'line' && item.type === 'stderr' ? 'text-error' : ''"
          >
            <span class="run-view__type">{{ item.kind === 'line' ? item.type : item.kind }}</span>
            <span>{{ item.kind === 'line' ? item.text : '' }}</span>
          </div>
          <div v-if="shown.length === 0" class="text-medium-emphasis pa-4">No runner output.</div>
        </div>
        <RunChat v-else :items="shown" :live="live" :detailed-system="tab === 'system'" />
        <div v-if="live" class="run-view__live text-caption text-medium-emphasis">
          <v-progress-circular indeterminate size="12" width="2" class="mr-2" />run in progress
        </div>
      </div>
      <v-fade-transition>
        <v-btn
          v-if="!follow"
          class="run-view__jump"
          color="primary"
          size="small"
          rounded="xl"
          :prepend-icon="mdiArrowDown"
          @click="jumpToLatest"
        >
          Jump to latest
        </v-btn>
      </v-fade-transition>
    </div>
  </div>
</template>

<style scoped>
.run-view__body {
  position: relative;
}
.run-view__scroll {
  overflow-y: auto;
}
.run-view__jump {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
}
.run-view__lines {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.82rem;
  padding: 8px 12px;
}
.run-view__line {
  display: flex;
  gap: 12px;
  padding: 2px 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.run-view__type {
  flex: 0 0 64px;
  opacity: 0.6;
}
.run-view__live {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px 0 12px;
}
</style>
