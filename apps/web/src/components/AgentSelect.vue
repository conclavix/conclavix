<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api/client';
import type { Agent, Page, ProjectAgent } from '../api/types';
import { describeError } from '../issues';
import { NOT_ENABLED_HINT, assigneeOptions, loadProjectAgents } from '../projects/agents';

const model = defineModel<string | null>({ required: true });
const props = defineProps<{
  label?: string;
  /** With a project, agents not enabled in it are shown but cannot be picked. */
  projectId?: string | null | undefined;
  /** The assignee already saved; it stays selectable even if it is no longer enabled. */
  current?: string | null | undefined;
}>();

const emit = defineEmits<{ access: [agents: ProjectAgent[] | null] }>();

const agents = ref<Agent[]>([]);
const access = ref<ProjectAgent[] | null>(null);
const error = ref('');
/** Failure to load the project's agent access; kept apart so a project change clears it. */
const accessError = ref('');
const errors = computed(() => [error.value, accessError.value].filter(Boolean));

onMounted(async () => {
  try {
    agents.value = (await api<Page<Agent>>('/agents')).items;
  } catch (cause) {
    error.value = describeError(cause);
  }
});

watch(
  () => props.projectId,
  async (projectId) => {
    access.value = null;
    accessError.value = '';
    emit('access', null);
    if (!projectId) return;
    try {
      const items = await loadProjectAgents(projectId);
      if (props.projectId !== projectId) return;
      access.value = items;
      emit('access', items);
    } catch (cause) {
      if (props.projectId === projectId) accessError.value = describeError(cause);
    }
  },
  { immediate: true },
);

const items = computed(() => assigneeOptions(agents.value, access.value, props.current ?? null));
</script>

<template>
  <v-select
    v-model="model"
    :items="items"
    item-title="name"
    item-value="id"
    :label="label ?? 'Assignee'"
    :error-messages="errors"
    clearable
    data-test="agent-select"
    @click:clear="model = null"
  >
    <template #item="{ props: itemProps, item }">
      <v-tooltip :disabled="!item.disabled" :text="NOT_ENABLED_HINT" location="end">
        <template #activator="{ props: tip }">
          <div v-bind="tip">
            <v-list-item
              v-bind="itemProps"
              :subtitle="item.subtitle"
              :disabled="item.disabled"
              :data-test="`agent-option-${item.name}`"
            />
          </div>
        </template>
      </v-tooltip>
    </template>
  </v-select>
</template>
