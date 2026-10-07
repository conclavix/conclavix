<script setup lang="ts">
import { computed } from 'vue';
import { ago, usd } from '../../format';
import { useLiveStore } from '../../stores/live';

const props = defineProps<{ now: number; pendingWakes: number }>();
const live = useLiveStore();

const running = computed(() => live.activeRuns.filter((run) => run.status === 'running'));
const queued = computed(() => live.activeRuns.filter((run) => run.status === 'queued'));
const agentName = (id?: string): string => (id && live.state.agents[id]?.name) || 'unknown agent';
const issueOf = (id?: string | null) => (id ? live.state.issues[id] : undefined);
const waiting = computed(() => queued.value.length + props.pendingWakes);
</script>

<template>
  <v-card>
    <v-card-title>Now</v-card-title>
    <v-card-subtitle v-if="waiting > 0">
      Waiting to start <strong class="tabular">{{ waiting }}</strong>
    </v-card-subtitle>
    <v-list density="compact" lines="two">
      <v-list-item
        v-for="run in running"
        :key="run.id"
        :to="
          issueOf(run.issueId)?.key
            ? { name: 'issue', params: { issueKey: issueOf(run.issueId)?.key } }
            : undefined
        "
        data-test="active-run"
      >
        <v-list-item-title>
          {{ agentName(run.agentId) }}
          <span class="text-medium-emphasis">on {{ issueOf(run.issueId)?.key ?? 'issue' }}</span>
        </v-list-item-title>
        <v-list-item-subtitle>{{ issueOf(run.issueId)?.title ?? '' }}</v-list-item-subtitle>
        <template #append>
          <div class="text-right text-body-medium tabular">
            <div>{{ ago(run.startedAt ?? run.createdAt, now) }}</div>
            <div class="text-medium-emphasis">{{ usd(run.costUsd ?? 0) }}</div>
          </div>
        </template>
      </v-list-item>
      <v-list-item
        v-for="run in queued"
        :key="run.id"
        :title="agentName(run.agentId)"
        :subtitle="`queued for ${issueOf(run.issueId)?.key ?? 'issue'} \u00b7 ${ago(run.createdAt, now)}`"
      />
      <v-list-item v-if="running.length === 0 && queued.length === 0">
        <v-list-item-subtitle>No agent is working right now.</v-list-item-subtitle>
      </v-list-item>
    </v-list>
  </v-card>
</template>

<style scoped>
.tabular {
  font-variant-numeric: tabular-nums;
}
</style>
