<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { errorText } from '../../agents/api';
import { duration } from '../../agents/form';
import { api } from '../../api/client';
import type { Issue, Page, Run } from '../../api/types';
import { ago, usd } from '../../format';
import { useLiveStore } from '../../stores/live';
import StatusChip from '../StatusChip.vue';

const props = defineProps<{ agentId: string }>();
const live = useLiveStore();

const fetched = ref<Run[]>([]);
const issueKeys = ref<Record<string, string>>({});
const loading = ref(false);
const error = ref('');
const now = ref(Date.now());
const timer = setInterval(() => (now.value = Date.now()), 1000);
onBeforeUnmount(() => clearInterval(timer));

async function resolveIssueKeys(runs: Run[]): Promise<void> {
  const ids = runs.flatMap((run) => (run.issueId ? [run.issueId] : []));
  const missing = [...new Set(ids)].filter(
    (id) => !live.state.issues[id]?.key && !issueKeys.value[id],
  );
  const found = await Promise.all(
    missing.map((id) => api<Issue>(`/issues/${id}`).catch(() => null)),
  );
  for (const issue of found) {
    if (issue) issueKeys.value[issue.id] = issue.key;
  }
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    fetched.value = (await api<Page<Run>>(`/runs?agentId=${props.agentId}&limit=50`)).items;
    await resolveIssueKeys(fetched.value);
  } catch (cause) {
    error.value = errorText(cause);
  } finally {
    loading.value = false;
  }
}
watch(() => props.agentId, load, { immediate: true });

const runs = computed(() => {
  const merged = new Map(fetched.value.map((run) => [run.id, run]));
  for (const run of Object.values(live.state.runs)) {
    if (run.agentId === props.agentId) {
      merged.set(run.id, { ...merged.get(run.id), ...run } as Run);
    }
  }
  return [...merged.values()].sort((a, b) => (b.id > a.id ? 1 : -1)).slice(0, 50);
});
const issueKey = (id: string | null): string =>
  id ? (live.state.issues[id]?.key ?? issueKeys.value[id] ?? '') : '';
</script>

<template>
  <div>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-2">{{ error }}</v-alert>
    <v-progress-linear v-if="loading" indeterminate />
    <v-table density="comfortable">
      <thead>
        <tr>
          <th>Status</th>
          <th>Issue</th>
          <th>Reason</th>
          <th>Started</th>
          <th>Duration</th>
          <th>Cost</th>
          <th />
        </tr>
      </thead>
      <tbody>
        <tr v-for="run in runs" :key="run.id">
          <td>
            <StatusChip :status="run.status" />
          </td>
          <td>
            <router-link
              v-if="issueKey(run.issueId)"
              :to="{ name: 'issue', params: { issueKey: issueKey(run.issueId) } }"
            >
              {{ issueKey(run.issueId) }}
            </router-link>
            <router-link
              v-else-if="run.chatId"
              :to="{ name: 'chat', params: { chatId: run.chatId } }"
            >
              CEO chat
            </router-link>
          </td>
          <td>{{ run.reason }}</td>
          <td>{{ run.startedAt ? `${ago(run.startedAt, now)} ago` : 'not yet' }}</td>
          <td>{{ duration(run.startedAt, run.finishedAt, now) }}</td>
          <td>{{ usd(run.costUsd) }}</td>
          <td class="text-right">
            <v-btn size="small" variant="text" :to="{ name: 'run', params: { runId: run.id } }">
              Log
            </v-btn>
          </td>
        </tr>
        <tr v-if="!loading && runs.length === 0">
          <td colspan="7" class="text-medium-emphasis">No runs yet.</td>
        </tr>
      </tbody>
    </v-table>
  </div>
</template>
