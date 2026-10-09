<script setup lang="ts">
import { mdiOpenInNew } from '@mdi/js';
import { computed } from 'vue';
import type { Run } from '../api/types';
import { runDuration, usd } from '../format';
import { useLiveStore } from '../stores/live';
import RunCodeSummary from './RunCodeSummary.vue';
import StatusChip from './StatusChip.vue';

const props = defineProps<{
  run: Partial<Run> & { id: string };
  now: number;
  linkDetail?: boolean;
}>();
const live = useLiveStore();

const agentName = computed(
  () => (props.run.agentId && live.state.agents[props.run.agentId]?.name) || 'unknown agent',
);
const issue = computed(() =>
  props.run.issueId ? live.state.issues[props.run.issueId] : undefined,
);
const took = computed(() => runDuration(props.run, props.now));
</script>

<template>
  <div class="run-header px-4 pt-3 pb-2">
    <div class="d-flex align-center flex-wrap ga-2">
      <slot name="prepend" />
      <span class="text-h6">{{ agentName }}</span>
      <router-link
        v-if="issue?.key"
        :to="{ name: 'issue', params: { issueKey: issue.key } }"
        class="text-body-1"
      >
        {{ issue.key }}
      </router-link>
      <router-link
        v-if="run.chatId"
        :to="{ name: 'chat', params: { chatId: run.chatId } }"
        class="text-body-1"
      >
        CEO chat
      </router-link>
      <span v-if="issue?.title" class="text-body-2 text-medium-emphasis run-header__title">
        {{ issue.title }}
      </span>
      <v-spacer />
      <StatusChip :status="run.status" />
      <v-btn
        v-if="linkDetail"
        :to="{ name: 'run', params: { runId: run.id } }"
        :prepend-icon="mdiOpenInNew"
        size="small"
        variant="text"
      >
        Details
      </v-btn>
    </div>
    <div class="d-flex flex-wrap ga-4 text-body-2 text-medium-emphasis mt-1">
      <span>wake: {{ run.reason }}</span>
      <span v-if="took">duration: {{ took }}</span>
      <span>cost: {{ usd(run.costUsd ?? 0) }}</span>
      <span v-if="run.startedAt">started: {{ new Date(run.startedAt).toLocaleString() }}</span>
    </div>
    <RunCodeSummary v-if="run.code && issue?.key" :code="run.code" :issue-key="issue.key" />
    <v-alert v-if="run.error" type="error" variant="tonal" density="compact" class="mt-2">
      {{ run.error }}
    </v-alert>
  </div>
</template>

<style scoped>
.run-header__title {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  max-width: 420px;
}
</style>
