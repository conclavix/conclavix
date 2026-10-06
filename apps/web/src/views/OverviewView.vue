<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import BarList, { type Bar } from '../components/charts/BarList.vue';
import ColumnChart, { type Column } from '../components/charts/ColumnChart.vue';
import ActivityFeed from '../components/overview/ActivityFeed.vue';
import AttentionCard from '../components/overview/AttentionCard.vue';
import KpiTiles from '../components/overview/KpiTiles.vue';
import NowCard from '../components/overview/NowCard.vue';
import { usd } from '../format';
import { useOverviewStore } from '../stores/overview';

const ISSUE_FLOW = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'];

const overview = useOverviewStore();
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  overview.retain();
  timer = setInterval(() => (now.value = Date.now()), 1000);
});
onBeforeUnmount(() => {
  overview.release();
  clearInterval(timer);
});

const data = computed(() => overview.data);
const costColumns = computed<Column[]>(() =>
  (data.value?.costPerDay ?? []).map((day) => ({
    label: day.date.slice(5),
    value: day.costUsd,
    detail: `${day.runs} runs${day.failed ? `, ${day.failed} failed` : ''}`,
  })),
);
const agentBars = computed<Bar[]>(() =>
  (data.value?.runsPerAgentToday ?? []).map((row) => ({
    key: row.agentId,
    label: row.name,
    value: row.runs,
    detail: usd(row.costUsd),
  })),
);
const issueBars = computed<Bar[]>(() =>
  ISSUE_FLOW.map((status) => ({
    key: status,
    label: status.replace('_', ' '),
    value: data.value?.issuesByStatus[status] ?? 0,
  })),
);
const updated = computed(() =>
  overview.loadedAt ? new Date(overview.loadedAt).toLocaleTimeString() : '',
);
</script>

<template>
  <v-container fluid class="pa-3">
    <div class="d-flex align-center mb-2">
      <h1 class="text-title-large">Overview</h1>
      <v-spacer />
      <span v-if="updated" class="text-body-small text-medium-emphasis">Updated {{ updated }}</span>
    </div>
    <v-alert v-if="overview.error" type="error" variant="tonal" density="compact" class="mb-2">
      Overview could not be loaded: {{ overview.error }}
    </v-alert>
    <v-skeleton-loader v-if="!data && !overview.error" type="card, card" />
    <template v-if="data">
      <div id="kpis"><KpiTiles :kpis="data.kpis" /></div>
      <v-row dense class="mt-1">
        <v-col cols="12" md="6">
          <NowCard :now="now" :pending-wakes="data.kpis.pendingWakes" />
        </v-col>
        <v-col cols="12" md="6">
          <AttentionCard :attention="data.attention" :now="now" @changed="overview.refresh()" />
        </v-col>
      </v-row>
      <v-row dense class="mt-1">
        <v-col cols="12" md="6">
          <v-card>
            <v-card-title>Cost per day</v-card-title>
            <v-card-subtitle>Last {{ data.days }} days, UTC</v-card-subtitle>
            <v-card-text>
              <ColumnChart :columns="costColumns" title="Cost per day" :format="usd" />
            </v-card-text>
          </v-card>
        </v-col>
        <v-col cols="12" sm="6" md="3">
          <v-card class="fill">
            <v-card-title>Runs per agent</v-card-title>
            <v-card-subtitle>Today, UTC</v-card-subtitle>
            <v-card-text>
              <BarList v-if="agentBars.length" :bars="agentBars" title="Runs per agent today" />
              <span v-else class="text-medium-emphasis">No runs today.</span>
            </v-card-text>
          </v-card>
        </v-col>
        <v-col cols="12" sm="6" md="3">
          <v-card class="fill">
            <v-card-title>Issues by status</v-card-title>
            <v-card-subtitle>All projects</v-card-subtitle>
            <v-card-text>
              <BarList :bars="issueBars" title="Issues by status" />
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>
      <v-row dense class="mt-1">
        <v-col cols="12">
          <ActivityFeed :items="data.activity" :now="now" />
        </v-col>
      </v-row>
    </template>
  </v-container>
</template>

<style scoped>
.fill {
  height: 100%;
}
</style>
