<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api } from '../api/client';
import type { Issue, Page } from '../api/types';
import { describeError } from '../issues';

const props = defineProps<{
  label: string;
  multiple?: boolean;
  projectId?: string;
  exclude?: string[];
}>();
const model = defineModel<string | string[] | null>({ required: true });

const known = ref<Record<string, Issue>>({});
const results = ref<string[]>([]);
const search = ref('');
const loading = ref(false);
const error = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;

const selectedIds = computed(() =>
  Array.isArray(model.value) ? model.value : model.value ? [model.value] : [],
);
const items = computed(() =>
  [...new Set([...selectedIds.value, ...results.value])]
    .filter((id) => !props.exclude?.includes(id))
    .map((id) => {
      const issue = known.value[id];
      return { value: id, title: issue ? `${issue.key} ${issue.title}` : id };
    }),
);

function remember(issues: Issue[]): void {
  known.value = { ...known.value, ...Object.fromEntries(issues.map((i) => [i.id, i])) };
}

async function resolveSelected(): Promise<void> {
  const missing = selectedIds.value.filter((id) => !known.value[id]);
  remember(await Promise.all(missing.map((id) => api<Issue>(`/issues/${id}`))));
}

async function runSearch(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const params = new URLSearchParams({ limit: '20' });
    if (search.value?.trim()) params.set('q', search.value.trim());
    if (props.projectId) params.set('projectId', props.projectId);
    const page = await api<Page<Issue>>(`/issues?${params.toString()}`);
    remember(page.items);
    results.value = page.items.map((issue) => issue.id);
  } catch (cause) {
    error.value = describeError(cause);
  } finally {
    loading.value = false;
  }
}

watch(search, () => {
  clearTimeout(timer);
  timer = setTimeout(() => void runSearch(), 250);
});
watch(
  selectedIds,
  () => void resolveSelected().catch((cause) => (error.value = describeError(cause))),
  { immediate: true },
);
watch(
  () => props.projectId,
  () => void runSearch(),
  { immediate: true },
);
</script>

<template>
  <v-autocomplete
    v-model="model"
    v-model:search="search"
    :items="items"
    :label="label"
    :multiple="multiple"
    :chips="multiple"
    :closable-chips="multiple"
    :loading="loading"
    :error-messages="error"
    no-filter
    clearable
    hide-no-data
    placeholder="Search by key or title"
  />
</template>
