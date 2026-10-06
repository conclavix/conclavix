<script setup lang="ts">
import { mdiArrowLeft } from '@mdi/js';
import { computed, ref, watch } from 'vue';
import RunHeader from '../components/RunHeader.vue';
import RunView from '../components/RunView.vue';
import { useNow } from '../composables';
import { isActive, useLiveStore } from '../stores/live';

const props = defineProps<{ runId: string }>();
const live = useLiveStore();
const now = useNow();
const error = ref<string | null>(null);

watch(
  () => props.runId,
  async (id) => {
    error.value = null;
    try {
      await live.loadRun(id);
      await live.loadLog(id);
    } catch (cause) {
      if (id === props.runId) {
        error.value = cause instanceof Error ? cause.message : String(cause);
      }
    }
  },
  { immediate: true },
);

const run = computed(() => live.state.runs[props.runId]);
const lines = computed(() => live.state.logs[props.runId] ?? []);
</script>

<template>
  <v-container fluid class="pa-3">
    <v-btn
      :to="{ name: 'runs' }"
      :prepend-icon="mdiArrowLeft"
      variant="text"
      size="small"
      class="mb-2"
    >
      All runs
    </v-btn>
    <v-alert v-if="error" type="error" variant="tonal">{{ error }}</v-alert>
    <v-card v-else-if="run">
      <RunHeader :run="run" :now="now" />
      <v-divider />
      <RunView
        :run-id="run.id"
        :lines="lines"
        :live="isActive(run.status)"
        height="calc(100vh - 250px)"
      />
    </v-card>
    <v-progress-linear v-else indeterminate />
  </v-container>
</template>
