<script setup lang="ts">
import { computed } from 'vue';

export interface Column {
  label: string;
  value: number;
  detail?: string;
}

const props = withDefaults(
  defineProps<{
    columns: Column[];
    title: string;
    format?: (value: number) => string;
    height?: number;
  }>(),
  { format: (value: number) => String(value), height: 120 },
);

const max = computed(() => Math.max(0, ...props.columns.map((column) => column.value)));
const percent = (value: number): number => (max.value > 0 ? (value / max.value) * 100 : 0);
const summary = computed(
  () =>
    `${props.title}: ${props.columns.map((c) => `${c.label} ${props.format(c.value)}`).join(', ')}`,
);
</script>

<template>
  <figure class="column-chart">
    <div class="axis-max text-body-small text-medium-emphasis">{{ format(max) }}</div>
    <div class="plot" :style="{ height: `${height}px` }" role="img" :aria-label="summary">
      <v-tooltip v-for="column in columns" :key="column.label" location="top">
        <template #activator="{ props: tip }">
          <div class="slot" v-bind="tip">
            <div
              class="bar"
              :class="{ empty: column.value === 0 }"
              :style="{ height: `${percent(column.value)}%` }"
            />
          </div>
        </template>
        {{ column.label }}: {{ format(column.value) }}
        <template v-if="column.detail"> &middot; {{ column.detail }}</template>
      </v-tooltip>
    </div>
    <div class="ticks text-body-small text-medium-emphasis">
      <span>{{ columns[0]?.label }}</span>
      <span>{{ columns.at(-1)?.label }}</span>
    </div>
    <table class="d-sr-only">
      <caption>
        {{
          title
        }}
      </caption>
      <tr v-for="column in columns" :key="column.label">
        <th scope="row">{{ column.label }}</th>
        <td>{{ format(column.value) }}</td>
      </tr>
    </table>
  </figure>
</template>

<style scoped>
.column-chart {
  margin: 0;
}
.plot {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.slot {
  flex: 1 1 0;
  height: 100%;
  display: flex;
  align-items: flex-end;
}
.slot:hover .bar {
  background: rgb(var(--v-theme-secondary));
}
.bar {
  width: 100%;
  min-height: 2px;
  border-radius: 4px 4px 0 0;
  background: rgb(var(--v-theme-primary));
}
.bar.empty {
  background: rgba(var(--v-border-color), var(--v-border-opacity));
}
.ticks {
  display: flex;
  justify-content: space-between;
  margin-top: 2px;
}
</style>
