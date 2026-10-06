<script setup lang="ts">
import { mdiSourceBranch, mdiSourceCommit } from '@mdi/js';
import { computed } from 'vue';
import type { RunCode } from '../api/types';
import { codeLink, codeSummary } from '../runs/code';

const props = defineProps<{ code: RunCode; issueKey: string }>();

const summary = computed(() => codeSummary(props.code));
const link = computed(() => codeLink(props.code, props.issueKey));
</script>

<template>
  <div class="d-flex flex-wrap align-center ga-2 mt-2" data-test="run-code">
    <v-chip
      :prepend-icon="code.commit ? mdiSourceCommit : mdiSourceBranch"
      :to="link"
      size="small"
      variant="outlined"
      data-test="run-code-link"
    >
      {{ summary.label }}
    </v-chip>
    <span class="text-body-2 text-medium-emphasis" data-test="run-code-stats">
      {{ summary.stats }}
    </span>
    <v-chip v-if="!code.synced" size="small" color="warning" variant="tonal">not synced</v-chip>
  </div>
  <v-alert
    v-if="code.error"
    type="warning"
    variant="tonal"
    density="compact"
    class="mt-2"
    data-test="run-code-error"
  >
    {{ code.error }}
  </v-alert>
</template>
