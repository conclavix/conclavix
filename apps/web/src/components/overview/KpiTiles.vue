<script setup lang="ts">
import { computed } from 'vue';
import type { Overview } from '../../api/overview';
import { usd } from '../../format';

const props = defineProps<{ kpis: Overview['kpis'] }>();

const tiles = computed(() => {
  const k = props.kpis;
  const share = k.dailyBudgetUsd > 0 ? Math.min(100, (k.costTodayUsd / k.dailyBudgetUsd) * 100) : 0;
  return [
    {
      id: 'runs',
      label: 'Runs today',
      value: String(k.runsToday),
      detail: k.failedToday > 0 ? `${k.failedToday} failed` : '',
    },
    {
      id: 'cost',
      label: 'Cost today (UTC)',
      value: usd(k.costTodayUsd),
      detail: `of ${usd(k.dailyBudgetUsd)} daily budget`,
      progress: share,
    },
    {
      id: 'done',
      label: 'Issues done today',
      value: String(k.issuesDoneToday),
      detail: `${k.issuesDone7d} in 7 days`,
    },
    {
      id: 'agents',
      label: 'Active agents',
      value: String(k.activeAgents),
      detail: `of ${k.totalAgents}`,
    },
  ];
});
</script>

<template>
  <v-row dense>
    <v-col v-for="tile in tiles" :key="tile.id" cols="6" md="3">
      <v-card class="tile" :data-kpi="tile.id">
        <v-card-text>
          <div class="text-body-small text-medium-emphasis">{{ tile.label }}</div>
          <div class="text-headline-small tabular">{{ tile.value }}</div>
          <div class="text-body-small text-medium-emphasis detail">{{ tile.detail }}</div>
          <v-progress-linear
            v-if="tile.progress !== undefined"
            :model-value="tile.progress"
            color="primary"
            rounded
            height="4"
            :aria-label="`${tile.label} ${tile.detail}`"
          />
        </v-card-text>
      </v-card>
    </v-col>
  </v-row>
</template>

<style scoped>
.tile {
  height: 100%;
}
.tabular {
  font-variant-numeric: tabular-nums;
}
.detail {
  min-height: 20px;
}
</style>
