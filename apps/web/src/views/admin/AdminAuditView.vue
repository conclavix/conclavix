<script setup lang="ts">
import { mdiChevronLeft, mdiChevronRight, mdiRefresh } from '@mdi/js';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { adminApi, type AdminUser, type AuditEntry } from '../../admin/api';
import {
  actorLabel,
  auditQuery,
  auditSummary,
  KNOWN_ACTIONS,
  userLabel,
  type AuditFilters,
} from '../../admin/audit';
import { errorText } from '../../admin/gating';

const HEADERS = [
  { title: 'Time', key: 'at', sortable: false },
  { title: 'Actor', key: 'actor', sortable: false },
  { title: 'Action', key: 'action', sortable: false },
  { title: 'Target', key: 'target', sortable: false },
  { title: 'Summary', key: 'summary', sortable: false },
  { title: 'IP', key: 'ip', sortable: false },
];

const filters = reactive<AuditFilters>({ actions: [], actor: null, from: '', to: '' });
const pageSize = ref(50);
const cursors = ref<(string | null)[]>([null]);
const items = ref<AuditEntry[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const users = ref<AdminUser[]>([]);
const namesLoaded = ref(false);
const namesError = ref<string | null>(null);

const names = computed(() =>
  Object.fromEntries(users.value.map((user) => [user.id, `${user.name} <${user.email}>`])),
);
const actorItems = computed(() => [
  { title: 'Board token', value: 'board' },
  { title: 'System', value: 'system' },
  { title: 'Agents', value: 'agent' },
  ...users.value.map((user) => ({ title: `${user.name} (${user.email})`, value: user.id })),
]);

onMounted(async () => {
  try {
    users.value = await adminApi.users();
    namesLoaded.value = true;
  } catch (cause) {
    // The log stays usable with ids; say so instead of calling everybody deleted.
    namesError.value = `User names could not be loaded (${errorText(cause)}); showing ids.`;
  }
});

let latest = 0;
async function fetchPage(): Promise<void> {
  const request = ++latest;
  loading.value = true;
  error.value = null;
  try {
    const page = await adminApi.audit(
      auditQuery(filters, pageSize.value, cursors.value.at(-1) ?? null),
    );
    if (request !== latest) return;
    items.value = page.items;
    nextCursor.value = page.nextCursor;
  } catch (cause) {
    if (request === latest) error.value = errorText(cause);
  } finally {
    if (request === latest) loading.value = false;
  }
}

function restart(): void {
  cursors.value = [null];
  void fetchPage();
}
function next(): void {
  if (!nextCursor.value) return;
  cursors.value = [...cursors.value, nextCursor.value];
  void fetchPage();
}
function previous(): void {
  if (cursors.value.length <= 1) return;
  cursors.value = cursors.value.slice(0, -1);
  void fetchPage();
}
watch([filters, pageSize], restart, { deep: true, immediate: true });

const target = (entry: AuditEntry): string => {
  if (!entry.targetUserId) {
    const email = entry.details['email'];
    return typeof email === 'string' ? email : '—';
  }
  return userLabel(entry.targetUserId, names.value, namesLoaded.value);
};
const actionColor = (action: string): string | undefined =>
  /failed|banned|deleted/.test(action)
    ? 'error'
    : /reset|role_changed|disabled|settings/.test(action)
      ? 'warning'
      : undefined;
</script>

<template>
  <v-container fluid class="pa-3">
    <v-card>
      <v-card-title class="d-flex align-center">
        Audit log
        <v-spacer />
        <v-btn
          :icon="mdiRefresh"
          variant="text"
          size="small"
          aria-label="Reload audit log"
          @click="restart"
        />
      </v-card-title>
      <v-card-text class="pb-0">
        <v-row dense>
          <v-col cols="12" md="4">
            <v-combobox
              v-model="filters.actions"
              :items="[...KNOWN_ACTIONS]"
              label="Action"
              multiple
              chips
              closable-chips
              clearable
              density="compact"
              hide-details
            />
          </v-col>
          <v-col cols="12" sm="6" md="4">
            <v-autocomplete
              v-model="filters.actor"
              :items="actorItems"
              label="Actor"
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
      <v-alert v-if="namesError" type="warning" variant="tonal" density="compact" class="ma-4">
        {{ namesError }}
      </v-alert>
      <v-data-table
        :headers="HEADERS"
        :items="items"
        :loading="loading"
        :items-per-page="-1"
        item-value="id"
        density="compact"
        hide-default-footer
      >
        <template #[`item.at`]="{ item }">
          <span class="text-no-wrap">{{ new Date(item.at).toLocaleString() }}</span>
        </template>
        <template #[`item.actor`]="{ item }">{{
          actorLabel(item.actor, names, namesLoaded)
        }}</template>
        <template #[`item.action`]="{ item }">
          <v-chip :color="actionColor(item.action)" variant="tonal" class="text-no-wrap">
            {{ item.action }}
          </v-chip>
        </template>
        <template #[`item.target`]="{ item }">{{ target(item) }}</template>
        <template #[`item.summary`]="{ item }">
          <span class="text-body-2">{{ auditSummary(item) }}</span>
        </template>
        <template #[`item.ip`]="{ item }">
          <span class="text-caption">{{ item.ip ?? '' }}</span>
        </template>
        <template #no-data>No audit entries match these filters.</template>
      </v-data-table>
      <v-card-actions class="justify-end">
        <span class="text-caption text-medium-emphasis mr-2">Per page</span>
        <v-select
          v-model="pageSize"
          :items="[25, 50, 100, 200]"
          density="compact"
          hide-details
          variant="plain"
          class="audit-page-size"
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
          :disabled="!nextCursor || loading"
          aria-label="Next page"
          @click="next"
        />
      </v-card-actions>
    </v-card>
  </v-container>
</template>

<style scoped>
.audit-page-size {
  max-width: 80px;
  flex: 0 0 auto;
}
</style>
