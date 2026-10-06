<script setup lang="ts">
import { computed } from 'vue';
import type { RouteLocationRaw } from 'vue-router';

export interface Bar {
  key: string;
  label: string;
  value: number;
  detail?: string;
  to?: RouteLocationRaw;
}

const props = withDefaults(
  defineProps<{ bars: Bar[]; title: string; format?: (value: number) => string }>(),
  { format: (value: number) => String(value) },
);

const max = computed(() => Math.max(0, ...props.bars.map((bar) => bar.value)));
const percent = (value: number): number => (max.value > 0 ? (value / max.value) * 100 : 0);
</script>

<template>
  <ul class="bar-list" :aria-label="title">
    <li v-for="bar in bars" :key="bar.key" class="row">
      <router-link v-if="bar.to" :to="bar.to" class="label text-body-medium">{{
        bar.label
      }}</router-link>
      <span v-else class="label text-body-medium">{{ bar.label }}</span>
      <span class="track" aria-hidden="true">
        <span class="fill" :style="{ width: `${percent(bar.value)}%` }" />
      </span>
      <span class="value text-body-medium">
        {{ format(bar.value) }}
        <span v-if="bar.detail" class="text-medium-emphasis">{{ bar.detail }}</span>
      </span>
    </li>
  </ul>
</template>

<style scoped>
.bar-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.row {
  display: grid;
  grid-template-columns: minmax(80px, 30%) 1fr auto;
  align-items: center;
  gap: 8px;
  height: 28px;
}
.label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: inherit;
}
.track {
  height: 10px;
}
.fill {
  display: block;
  height: 100%;
  min-width: 2px;
  border-radius: 0 4px 4px 0;
  background: rgb(var(--v-theme-primary));
}
.value {
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}
</style>
