<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { useDisplay } from 'vuetify';
import { statusItems, statusSummary } from '../overview/status';
import { useLiveStore } from '../stores/live';
import { useOverviewStore } from '../stores/overview';

const live = useLiveStore();
const overview = useOverviewStore();
const { smAndDown } = useDisplay();

onMounted(() => overview.retain());
onBeforeUnmount(() => overview.release());

const items = computed(() =>
  statusItems({
    running: live.activeRuns.filter((run) => run.status === 'running').length,
    queued: live.activeRuns.filter((run) => run.status === 'queued').length,
    pausedAgents: Object.values(live.state.agents).filter((agent) => agent.status === 'paused')
      .length,
    overview: overview.data,
  }),
);
const summary = computed(() => statusSummary(items.value));
</script>

<template>
  <nav class="header-status" aria-label="Status">
    <template v-if="!smAndDown">
      <v-chip
        v-for="item in items"
        :key="item.id"
        :to="item.to"
        :color="item.color"
        class="status-chip"
        :data-status="item.id"
      >
        {{ item.label }}<span class="status-value">{{ item.value }}</span>
      </v-chip>
    </template>
    <v-menu v-else-if="summary" location="bottom end">
      <template #activator="{ props: menu }">
        <v-chip v-bind="menu" :color="summary.color" class="status-chip" data-status="summary">
          {{ summary.label }}<span class="status-value">{{ summary.value }}</span>
        </v-chip>
      </template>
      <v-list density="compact" min-width="220">
        <v-list-item v-for="item in items" :key="item.id" :to="item.to" :title="item.label">
          <template #append>
            <v-chip :color="item.color" class="status-chip">{{ item.value }}</v-chip>
          </template>
        </v-list-item>
      </v-list>
    </v-menu>
  </nav>
</template>

<style scoped>
.header-status {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  margin-right: 8px;
  overflow: hidden;
}
.status-chip {
  height: 24px;
  flex-shrink: 0;
}
.status-value {
  margin-left: 6px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
</style>
