<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api/client';
import type { MemoryScope } from '../api/memory';
import type { Agent } from '../api/types';
import MemoryPanel from '../components/memory/MemoryPanel.vue';
import { bucketFor } from '../memory/logic';
import { errorText } from '../memory/useMemories';

interface Option {
  value: string;
  title: string;
}

const LEVELS: { value: MemoryScope; title: string; hint: string }[] = [
  { value: 'global', title: 'Global', hint: 'Read by every agent. Only the board writes here.' },
  {
    value: 'project',
    title: 'Project',
    hint: 'Read and written by agents working in the project.',
  },
  { value: 'agent', title: 'Agent', hint: "An agent's own notes; no other agent sees them." },
];

const route = useRoute();
const router = useRouter();
const projects = ref<Option[]>([]);
const agents = ref<Option[]>([]);
const error = ref('');

const queryValue = (key: string): string | null => {
  const value = route.query[key];
  return typeof value === 'string' && value ? value : null;
};
const level = computed<MemoryScope>(() => {
  const value = queryValue('level');
  return LEVELS.some((entry) => entry.value === value) ? (value as MemoryScope) : 'global';
});
const projectId = computed(() => queryValue('project'));
const agentId = computed(() => queryValue('agent'));
const bucketKey = computed(() =>
  JSON.stringify(bucketFor(level.value, projectId.value, agentId.value)),
);
const hint = computed(() => LEVELS.find((entry) => entry.value === level.value)?.hint ?? '');

function select(changes: Record<string, string | null>): void {
  const merged: Record<string, unknown> = { ...route.query, ...changes };
  const query = Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== null));
  void router.replace({ query: query as typeof route.query });
}

onMounted(async () => {
  const reportError = (cause: unknown): void => {
    if (!error.value) error.value = errorText(cause);
  };
  await Promise.all([
    api<{ items: { id: string; key: string; name: string }[] }>('/projects')
      .then((page) => {
        projects.value = page.items.map((p) => ({ value: p.id, title: `${p.key} ${p.name}` }));
      })
      .catch(reportError),
    api<{ items: Agent[] }>('/agents')
      .then((page) => {
        agents.value = page.items.map((a) => ({ value: a.id, title: `${a.name} (${a.title})` }));
      })
      .catch(reportError),
  ]);
});
</script>

<template>
  <v-container class="pa-3" style="max-width: 1100px">
    <div class="text-h6 mb-2">Knowledge</div>
    <v-tabs
      :model-value="level"
      class="mb-3"
      data-test="memory-levels"
      @update:model-value="(value) => select({ level: String(value) })"
    >
      <v-tab v-for="entry in LEVELS" :key="entry.value" :value="entry.value">
        {{ entry.title }}
      </v-tab>
    </v-tabs>
    <p class="text-body-2 text-medium-emphasis mb-3">{{ hint }}</p>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-3">{{ error }}</v-alert>
    <v-autocomplete
      v-if="level === 'project'"
      :model-value="projectId"
      :items="projects"
      label="Project"
      density="compact"
      data-test="memory-project-picker"
      @update:model-value="(value: string | null) => select({ project: value })"
    />
    <v-autocomplete
      v-if="level === 'agent'"
      :model-value="agentId"
      :items="agents"
      label="Agent"
      density="compact"
      data-test="memory-agent-picker"
      @update:model-value="(value: string | null) => select({ agent: value })"
    />
    <MemoryPanel :key="bucketKey" :scope="level" :project-id="projectId" :agent-id="agentId" />
  </v-container>
</template>
