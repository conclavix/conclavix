<script setup lang="ts">
import { mdiChevronLeft, mdiChevronRight, mdiRefresh } from '@mdi/js';
import { computed, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api/client';
import type { Page, Run } from '../api/types';
import { useNow } from '../composables';
import StatusChip from '../components/StatusChip.vue';
import { runDuration, usd } from '../format';
import { useLiveStore } from '../stores/live';
import { runsQuery, type RunFilters } from '../stores/runs-query';

const STATUSES = ['queued', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled'];
const HEADERS = [
  { title: 'Agent', key: 'agent', sortable: false },
  { title: 'Issue', key: 'issue', sortable: false },
  { title: 'Status', key: 'status', sortable: false },
  { title: 'Reason', key: 'reason', sortable: false },
  { title: 'Started', key: 'startedAt', sortable: false },
  { title: 'Duration', key: 'duration', sortable: false },
  { title: 'Cost', key: 'costUsd', sortable: false, align: 'end' as const },
];

const live = useLiveStore();
const router = useRouter();
const now = useNow();

const filters = reactive<RunFilters>({
  statuses: [],
  agentId: null,
  issueId: null,
  from: '',
  to: '',
});
const pageSize = ref(25);
const cursors = ref<(string | null)[]>([null]);
const page = ref<Page<Run>>({ items: [], nextCursor: null });
const loading = ref(false);
const error = ref<string | null>(null);

const agents = computed(() =>
  Object.values(live.state.agents).map((agent) => ({
    title: agent.name ?? agent.id,
    value: agent.id,
  })),
);
const issues = computed(() =>
  Object.values(live.state.issues).map((issue) => ({
    title: `${issue.key ?? ''} ${issue.title ?? ''}`.trim(),
    value: issue.id,
  })),
);
const rows = computed(() =>
  page.value.items.map((run) => ({ ...run, ...live.state.runs[run.id] })),
);

let latestRequestId = 0;

async function fetchPage(): Promise<void> {
  const requestId = ++latestRequestId;
  loading.value = true;
  error.value = null;
  try {
    const before = cursors.value.at(-1) ?? null;
    const result = await api<Page<Run>>(`/runs?${runsQuery(filters, pageSize.value, before)}`);
    if (requestId !== latestRequestId) return;
    page.value = result;
    void live.ensureIssues(page.value.items.map((run) => run.issueId)).catch((cause: unknown) => {
      if (requestId === latestRequestId) {
        error.value = `could not load issue keys: ${cause instanceof Error ? cause.message : String(cause)}`;
      }
    });
  } catch (cause) {
    if (requestId === latestRequestId) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  } finally {
    if (requestId === latestRequestId) {
      loading.value = false;
    }
  }
}

function restart(): void {
  cursors.value = [null];
  void fetchPage();
}

function next(): void {
  if (!page.value.nextCursor) return;
  cursors.value = [...cursors.value, page.value.nextCursor];
  void fetchPage();
}

function previous(): void {
  if (cursors.value.length <= 1) return;
  cursors.value = cursors.value.slice(0, -1);
  void fetchPage();
}

watch([filters, pageSize], restart, { deep: true, immediate: true });

const agentName = (id: string): string => live.state.agents[id]?.name ?? 'unknown agent';
const issueKey = (id: string | null): string =>
  id ? (live.state.issues[id]?.key ?? '...') : 'CEO chat';
const open = (_event: unknown, row: { item: Run }): void => {
  void router.push({ name: 'run', params: { runId: row.item.id } });
};
</script>

<template>
  <v-container fluid class="pa-3">
    <v-card>
      <v-card-title class="d-flex align-center">
        Runs
        <v-spacer />
        <v-btn
          :icon="mdiRefresh"
          variant="text"
          size="small"
          aria-label="Reload"
          @click="restart"
        />
      </v-card-title>
      <v-card-text class="pb-0">
        <v-row dense>
          <v-col cols="12" sm="6" md="3">
            <v-select
              v-model="filters.statuses"
              :items="STATUSES"
              label="Status"
              multiple
              chips
              closable-chips
              clearable
              density="compact"
              hide-details
            />
          </v-col>
          <v-col cols="12" sm="6" md="3">
            <v-select
              v-model="filters.agentId"
              :items="agents"
              label="Agent"
              clearable
              density="compact"
              hide-details
            />
          </v-col>
          <v-col cols="12" sm="6" md="2">
            <v-autocomplete
              v-model="filters.issueId"
              :items="issues"
              label="Issue"
              clearable
              density="compact"
              hide-details
            />
          </v-col>
          <v-col cols="6" sm="3" md="2">
            <v-text-field
              v-model="filters.from"
              type="date"
              label="From"
              density="compact"
              hide-details
            />
          </v-col>
          <v-col cols="6" sm="3" md="2">
            <v-text-field
              v-model="filters.to"
              type="date"
              label="To"
              density="compact"
              hide-details
            />
          </v-col>
        </v-row>
      </v-card-text>
      <v-alert v-if="error" type="error" variant="tonal" class="ma-4">{{ error }}</v-alert>
      <v-data-table
        :headers="HEADERS"
        :items="rows"
        :loading="loading"
        :items-per-page="-1"
        item-value="id"
        density="compact"
        hover
        hide-default-footer
        class="runs-table"
        @click:row="open"
      >
        <template #[`item.agent`]="{ item }">{{ agentName(item.agentId) }}</template>
        <template #[`item.issue`]="{ item }">{{ issueKey(item.issueId) }}</template>
        <template #[`item.status`]="{ item }">
          <StatusChip :status="item.status" />
        </template>
        <template #[`item.reason`]="{ item }">
          <span>{{ item.reason }}</span>
          <div v-if="item.error" class="text-caption text-error runs-table__error">
            {{ item.error }}
          </div>
        </template>
        <template #[`item.startedAt`]="{ item }">
          {{ new Date(item.startedAt ?? item.createdAt ?? '').toLocaleString() }}
        </template>
        <template #[`item.duration`]="{ item }">{{ runDuration(item, now) }}</template>
        <template #[`item.costUsd`]="{ item }">{{ usd(item.costUsd) }}</template>
        <template #no-data>No runs match these filters.</template>
      </v-data-table>
      <v-card-actions class="justify-end">
        <span class="text-caption text-medium-emphasis mr-2">Per page</span>
        <v-select
          v-model="pageSize"
          :items="[25, 50, 100]"
          density="compact"
          hide-details
          variant="plain"
          class="runs-page-size"
        />
        <span class="text-body-2 mx-3">Page {{ cursors.length }}</span>
        <v-btn
          :icon="mdiChevronLeft"
          :disabled="cursors.length <= 1 || loading"
          aria-label="Previous page"
          @click="previous"
        />
        <v-btn
          :icon="mdiChevronRight"
          :disabled="!page.nextCursor || loading"
          aria-label="Next page"
          @click="next"
        />
      </v-card-actions>
    </v-card>
  </v-container>
</template>

<style scoped>
.runs-table :deep(tbody tr) {
  cursor: pointer;
}
.runs-table__error {
  max-width: 320px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.runs-page-size {
  max-width: 72px;
  flex: 0 0 auto;
}
</style>
