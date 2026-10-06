<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { errorText } from '../../agents/api';
import { WAKEABLE_STATUSES } from '../../agents/issues';
import { api } from '../../api/client';
import type { AgentDetail, Issue, Page } from '../../api/types';

const open = defineModel<boolean>({ required: true });
const props = defineProps<{ agent: AgentDetail; issueId?: string | null }>();

const issues = ref<Issue[]>([]);
const selected = ref<string | null>(null);
const loading = ref(false);
const waking = ref(false);
const error = ref('');
const result = ref<{ queued: boolean; text: string } | null>(null);

const items = computed(() =>
  issues.value.map((issue) => ({ value: issue.id, title: `${issue.key} ${issue.title}` })),
);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const page = await api<Page<Issue>>(
      `/issues?assigneeAgentId=${props.agent.id}&status=${WAKEABLE_STATUSES.join(',')}&limit=100`,
    );
    issues.value = page.items;
    selected.value = props.issueId ?? page.items[0]?.id ?? null;
  } catch (cause) {
    error.value = errorText(cause);
  } finally {
    loading.value = false;
  }
}

watch(open, (isOpen) => {
  if (!isOpen) return;
  error.value = '';
  result.value = null;
  void load();
});

async function wake(): Promise<void> {
  if (!selected.value) return;
  waking.value = true;
  error.value = '';
  try {
    const { queued } = await api<{ queued: boolean }>(`/agents/${props.agent.id}/wake`, {
      method: 'POST',
      body: JSON.stringify({ issueId: selected.value }),
    });
    result.value = {
      queued,
      text: queued
        ? 'Wake queued; the scheduler starts a run within seconds.'
        : 'A wake for this issue is already pending.',
    };
  } catch (cause) {
    error.value = errorText(cause);
  } finally {
    waking.value = false;
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="560">
    <v-card :title="`Wake ${agent.name}`">
      <v-card-text>
        <p class="text-body-2 mb-3">
          A wake always concerns one issue: the agent gets a run for it. Only issues assigned to
          this agent in todo or in progress can be woken.
        </p>
        <v-alert v-if="agent.status === 'paused'" type="warning" variant="tonal" class="mb-3">
          The agent is paused; the scheduler skips wakes until it is active again.
        </v-alert>
        <v-select
          v-model="selected"
          :items="items"
          :loading="loading"
          label="Issue"
          :no-data-text="'No assigned issue in todo or in progress'"
        />
        <v-alert v-if="result" :type="result.queued ? 'success' : 'info'" variant="tonal">
          {{ result.text }}
        </v-alert>
        <v-alert v-if="error" type="error" variant="tonal">{{ error }}</v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="open = false">Close</v-btn>
        <v-btn color="primary" variant="flat" :disabled="!selected" :loading="waking" @click="wake">
          Wake
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
