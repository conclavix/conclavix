<script setup lang="ts">
import { mdiHistory } from '@mdi/js';
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import AvatarImage from '../components/AvatarImage.vue';
import RunHeader from '../components/RunHeader.vue';
import RunView from '../components/RunView.vue';
import StatusChip from '../components/StatusChip.vue';
import { useNow } from '../composables';
import { ago, usd } from '../format';
import { isActive, useLiveStore } from '../stores/live';

const RECENT = 5;

const live = useLiveStore();
const route = useRoute();
const requested = route.query['run'];
const selected = ref<string | null>(typeof requested === 'string' ? requested : null);
const now = useNow();

const recent = computed(() => live.recentRuns.slice(0, RECENT));
const agentName = (id?: string): string => (id && live.state.agents[id]?.name) || 'unknown agent';
const agentAvatar = (id?: string): string | null =>
  (id && live.state.agents[id]?.avatarUrl) || null;
const issueOf = (id?: string | null) => (id ? live.state.issues[id] : undefined);

watch(
  selected,
  (id) => {
    if (!id) return;
    void live.loadLog(id);
    if (!live.state.runs[id]) void live.loadRun(id);
  },
  { immediate: true },
);
watch(
  () => [...live.activeRuns, ...recent.value],
  (runs) => {
    if (!selected.value && runs[0]) selected.value = runs[0].id;
  },
  { immediate: true },
);

const selectedRun = computed(() => (selected.value ? live.state.runs[selected.value] : undefined));
const lines = computed(() => (selected.value ? (live.state.logs[selected.value] ?? []) : []));
</script>

<template>
  <v-container fluid class="pa-3">
    <v-row dense>
      <v-col cols="12" md="4">
        <v-card>
          <v-card-title class="d-flex align-center">
            Now
            <v-spacer />
            <v-chip color="primary">{{ live.activeRuns.length }} active</v-chip>
          </v-card-title>
          <v-list density="compact" lines="two" class="run-list">
            <v-list-item
              v-for="run in live.activeRuns"
              :key="run.id"
              :active="run.id === selected"
              @click="selected = run.id"
            >
              <template #prepend>
                <AvatarImage
                  :name="agentName(run.agentId)"
                  :color-key="run.agentId"
                  :src="agentAvatar(run.agentId)"
                  :size="32"
                  class="mr-3"
                />
              </template>
              <v-list-item-title>
                {{ issueOf(run.issueId)?.key ?? '' }} {{ issueOf(run.issueId)?.title ?? '' }}
              </v-list-item-title>
              <v-list-item-subtitle>
                {{ agentName(run.agentId) }} · {{ run.reason }} ·
                {{ ago(run.startedAt ?? run.createdAt, now) }}
              </v-list-item-subtitle>
              <template #append>
                <StatusChip :status="run.status" />
              </template>
            </v-list-item>
            <v-list-item
              v-if="live.activeRuns.length === 0"
              title="Nothing running"
              subtitle="Runs appear here as soon as an agent wakes up."
            />
          </v-list>
          <v-divider />
          <v-card-subtitle class="pt-3 d-flex align-center">
            Recent
            <v-spacer />
            <v-btn :to="{ name: 'runs' }" :prepend-icon="mdiHistory" size="small" variant="text">
              All runs
            </v-btn>
          </v-card-subtitle>
          <v-list density="compact">
            <v-list-item
              v-for="run in recent"
              :key="run.id"
              :active="run.id === selected"
              @click="selected = run.id"
            >
              <template #prepend>
                <AvatarImage
                  :name="agentName(run.agentId)"
                  :color-key="run.agentId"
                  :src="agentAvatar(run.agentId)"
                  :size="32"
                  class="mr-3"
                />
              </template>
              <v-list-item-title class="text-body-2">
                {{ issueOf(run.issueId)?.key ?? '' }} · {{ agentName(run.agentId) }}
              </v-list-item-title>
              <template #append>
                <span class="text-caption text-medium-emphasis mr-2">
                  {{ ago(run.finishedAt ?? run.startedAt ?? run.createdAt, now) }}
                  <template v-if="run.costUsd"> · {{ usd(run.costUsd) }}</template>
                </span>
                <StatusChip :status="run.status" size="x-small" />
              </template>
            </v-list-item>
            <v-list-item v-if="recent.length === 0" title="No finished runs yet" />
          </v-list>
        </v-card>
      </v-col>
      <v-col cols="12" md="8">
        <v-card v-if="selectedRun">
          <RunHeader :run="selectedRun" :now="now" link-detail>
            <template #prepend>
              <AvatarImage
                :name="agentName(selectedRun.agentId)"
                :color-key="selectedRun.agentId"
                :src="agentAvatar(selectedRun.agentId)"
                :size="32"
              />
            </template>
          </RunHeader>
          <v-divider />
          <RunView
            :run-id="selectedRun.id"
            :lines="lines"
            :live="isActive(selectedRun.status)"
            height="calc(100vh - 260px)"
          />
        </v-card>
        <v-card v-else>
          <v-card-text class="text-medium-emphasis">No run selected.</v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>

<style scoped>
.run-list {
  max-height: 45vh;
  overflow-y: auto;
}
</style>
