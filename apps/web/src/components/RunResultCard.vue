<script setup lang="ts">
import { mdiAlertOctagonOutline, mdiFlagCheckered } from '@mdi/js';
import { computed } from 'vue';
import { duration, tokens, usd } from '../format';
import type { ResultItem } from '../stores/run-view';
import MarkdownBlock from './MarkdownBlock.vue';

const props = defineProps<{ item: ResultItem }>();

const stats = computed(() => {
  const item = props.item;
  const list: { label: string; value: string }[] = [];
  if (item.totalCostUsd !== null) list.push({ label: 'Cost', value: usd(item.totalCostUsd) });
  if (item.numTurns !== null) list.push({ label: 'Turns', value: String(item.numTurns) });
  if (item.durationMs !== null) list.push({ label: 'Duration', value: duration(item.durationMs) });
  if (item.usage) {
    list.push(
      { label: 'Input', value: tokens(item.usage.inputTokens) },
      { label: 'Output', value: tokens(item.usage.outputTokens) },
      { label: 'Cache read', value: tokens(item.usage.cacheReadInputTokens) },
      { label: 'Cache write', value: tokens(item.usage.cacheCreationInputTokens) },
    );
  }
  return list;
});
</script>

<template>
  <v-card variant="tonal" :color="item.isError ? 'error' : 'success'" class="result-card">
    <v-card-item class="py-2">
      <template #prepend>
        <v-icon :icon="item.isError ? mdiAlertOctagonOutline : mdiFlagCheckered" />
      </template>
      <v-card-title class="text-subtitle-1">
        {{ item.isError ? 'Run ended with an error' : 'Run finished' }}
      </v-card-title>
      <v-card-subtitle>{{ item.subtype }}</v-card-subtitle>
    </v-card-item>
    <div v-if="stats.length" class="result-card__stats px-4 pb-2">
      <div v-for="stat in stats" :key="stat.label" class="result-card__stat">
        <div class="text-caption text-medium-emphasis">{{ stat.label }}</div>
        <div class="text-body-2 font-weight-medium">{{ stat.value }}</div>
      </div>
    </div>
    <v-card-text v-if="item.result" class="pt-0 text-high-emphasis">
      <MarkdownBlock :source="item.result" />
    </v-card-text>
  </v-card>
</template>

<style scoped>
.result-card__stats {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 20px;
}
.result-card__stat {
  min-width: 64px;
}
</style>
