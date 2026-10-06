<script setup lang="ts">
import { mdiAlarm } from '@mdi/js';
import { computed, ref, watch } from 'vue';
import { errorText } from '../../agents/api';
import { isWakeable, sortTasks } from '../../agents/issues';
import { api } from '../../api/client';
import type { Issue, Page } from '../../api/types';
import { ago } from '../../format';
import { useLiveStore } from '../../stores/live';
import StatusChip from '../StatusChip.vue';

const props = defineProps<{ agentId: string }>();
const emit = defineEmits<{ wake: [issue: Issue] }>();
const live = useLiveStore();

const issues = ref<Issue[]>([]);
const showClosed = ref(false);
const loading = ref(false);
const error = ref('');

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const status = showClosed.value ? '' : '&status=backlog,todo,in_progress,in_review';
    const page = await api<Page<Issue>>(
      `/issues?assigneeAgentId=${props.agentId}&limit=100${status}`,
    );
    issues.value = page.items;
  } catch (cause) {
    error.value = errorText(cause);
  } finally {
    loading.value = false;
  }
}
watch([() => props.agentId, showClosed], load, { immediate: true });

const rows = computed(() =>
  sortTasks(issues.value.map((issue) => ({ ...issue, ...live.state.issues[issue.id] }) as Issue)),
);
</script>

<template>
  <div>
    <div class="d-flex align-center mb-2">
      <v-switch v-model="showClosed" label="Include closed issues" hide-details density="compact" />
    </div>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-2">{{ error }}</v-alert>
    <v-progress-linear v-if="loading" indeterminate />
    <v-table density="comfortable">
      <thead>
        <tr>
          <th>Issue</th>
          <th>Title</th>
          <th>Status</th>
          <th>Priority</th>
          <th>Updated</th>
          <th />
        </tr>
      </thead>
      <tbody>
        <tr v-for="issue in rows" :key="issue.id">
          <td>
            <router-link :to="{ name: 'issue', params: { issueKey: issue.key } }">
              {{ issue.key }}
            </router-link>
          </td>
          <td>{{ issue.title }}</td>
          <td>
            <StatusChip :status="issue.status" />
            <v-chip v-if="issue.checkoutRunId" color="primary" class="ml-1">working</v-chip>
          </td>
          <td>{{ issue.priority }}</td>
          <td>{{ ago(issue.updatedAt) }}</td>
          <td class="text-right">
            <v-btn
              v-if="isWakeable(issue)"
              :prepend-icon="mdiAlarm"
              size="small"
              variant="text"
              @click="emit('wake', issue)"
            >
              Wake
            </v-btn>
          </td>
        </tr>
        <tr v-if="!loading && rows.length === 0">
          <td colspan="6" class="text-medium-emphasis">No issues assigned to this agent.</td>
        </tr>
      </tbody>
    </v-table>
  </div>
</template>
