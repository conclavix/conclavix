<script setup lang="ts">
import { mdiDelete, mdiLanConnect, mdiPencil, mdiPlus, mdiPowerPlugOutline } from '@mdi/js';
import { computed, ref, watch } from 'vue';
import { connectionsApi, type Connection, type ConnectionTypeInfo } from '../../api/connections';
import type { SecretAgent } from '../../api/secrets';
import { connectionErrorText } from '../../connections/form';
import { ago } from '../../format';
import AdminConfirmDialog from '../admin/AdminConfirmDialog.vue';
import ConnectionDialog from './ConnectionDialog.vue';

const props = defineProps<{
  /** On a project page: only this project's connections, new ones belong to it. */
  projectId: string | null;
  isOwner: boolean;
  projects: { id: string; key: string; name: string }[];
}>();

const items = ref<Connection[]>([]);
const types = ref<ConnectionTypeInfo[]>([]);
const agents = ref<SecretAgent[]>([]);
const loading = ref(false);
const loadError = ref('');
const dialog = ref(false);
const editing = ref<Connection | null>(null);
const testing = ref<string | null>(null);
const testError = ref<Record<string, string>>({});
const deleting = ref<Connection | null>(null);
const deleteOpen = ref(false);
const deleteBusy = ref(false);
const deleteError = ref('');

const agentName = computed(() => new Map(agents.value.map((agent) => [agent.id, agent.name])));
const typeLabel = computed(() => new Map(types.value.map((type) => [type.id, type.label])));
const projectKey = computed(
  () => new Map(props.projects.map((project) => [project.id, project.key])),
);

async function load(): Promise<void> {
  const projectId = props.projectId;
  loading.value = true;
  loadError.value = '';
  try {
    const result = await connectionsApi.list(projectId ?? undefined);
    if (props.projectId !== projectId) return;
    items.value = result.items;
    types.value = result.types;
    agents.value = result.agents;
  } catch (cause) {
    if (props.projectId === projectId) loadError.value = connectionErrorText(cause);
  } finally {
    if (props.projectId === projectId) loading.value = false;
  }
}
watch(() => props.projectId, load, { immediate: true });

/** Show a saved or tested connection, unless the panel moved on to another project meanwhile. */
function upsert(connection: Connection): void {
  if (props.projectId !== null && connection.projectId !== props.projectId) return;
  items.value = [...items.value.filter((item) => item.id !== connection.id), connection].sort(
    (a, b) => a.name.localeCompare(b.name),
  );
}

function startCreate(): void {
  editing.value = null;
  dialog.value = true;
}

function startEdit(connection: Connection): void {
  editing.value = connection;
  dialog.value = true;
}

async function test(connection: Connection): Promise<void> {
  testing.value = connection.id;
  testError.value = { ...testError.value, [connection.id]: '' };
  try {
    upsert(await connectionsApi.test(connection.id));
  } catch (cause) {
    testError.value = { ...testError.value, [connection.id]: connectionErrorText(cause) };
  } finally {
    testing.value = null;
  }
}

function askDelete(connection: Connection): void {
  deleting.value = connection;
  deleteError.value = '';
  deleteOpen.value = true;
}

async function confirmDelete(): Promise<void> {
  const connection = deleting.value;
  if (!connection) return;
  deleteBusy.value = true;
  try {
    await connectionsApi.remove(connection.id);
    items.value = items.value.filter((item) => item.id !== connection.id);
    deleteOpen.value = false;
  } catch (cause) {
    deleteError.value = connectionErrorText(cause);
  } finally {
    deleteBusy.value = false;
  }
}

const missing = (connection: Connection) =>
  connection.credentials.filter((entry) => !entry.set).map((entry) => entry.key);
</script>

<template>
  <div data-test="connections-panel">
    <div class="d-flex align-start flex-wrap ga-2 mb-2">
      <p class="text-body-2 text-medium-emphasis flex-1-1 ma-0" style="min-width: 260px">
        <template v-if="projectId">
          Connections only this project's runs use. Instance-wide connections are managed under
          Administration → Connections.
        </template>
        <template v-else>
          External systems agents may use. An MCP server connection adds its tools to the runs of
          the agents you select (read-only and coding runs). Credentials are stored encrypted and
          never shown again.
        </template>
      </p>
      <v-btn
        color="primary"
        :prepend-icon="mdiPlus"
        :disabled="types.length === 0"
        data-test="connection-add"
        @click="startCreate"
      >
        Add connection
      </v-btn>
    </div>
    <v-alert v-if="loadError" type="error" variant="tonal" density="compact" class="mb-2">
      {{ loadError }}
    </v-alert>
    <v-progress-linear v-if="loading" indeterminate class="mb-2" />
    <v-card v-if="!loading && !loadError && items.length === 0" variant="outlined" class="pa-6">
      <div class="d-flex align-center ga-3 text-medium-emphasis">
        <v-icon :icon="mdiPowerPlugOutline" />
        No connections yet.
      </div>
    </v-card>
    <v-card v-if="items.length > 0" variant="outlined">
      <v-table density="comfortable">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Type</th>
            <th v-if="!projectId" scope="col">Scope</th>
            <th scope="col">Agents</th>
            <th scope="col">Status</th>
            <th scope="col" class="text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in items" :key="item.id" :data-test="`connection-${item.name}`">
            <td>
              <div class="font-weight-medium">{{ item.name }}</div>
              <div class="text-caption text-medium-emphasis connection-url">
                {{ item.config['url'] }}
              </div>
              <v-chip
                v-if="item.allowPrivateNetwork"
                size="x-small"
                color="warning"
                variant="tonal"
                class="mt-1"
              >
                private networks allowed
              </v-chip>
            </td>
            <td>{{ typeLabel.get(item.type) ?? item.type }}</td>
            <td v-if="!projectId">
              {{
                item.scope === 'instance'
                  ? 'instance'
                  : (projectKey.get(item.projectId ?? '') ?? 'project')
              }}
            </td>
            <td>
              <div class="d-flex flex-wrap ga-1 py-1">
                <v-chip v-for="id in item.agentIds" :key="id" size="small" variant="tonal">
                  {{ agentName.get(id) ?? 'deleted agent' }}
                </v-chip>
                <span v-if="item.agentIds.length === 0" class="text-medium-emphasis">none</span>
              </div>
            </td>
            <td data-test="connection-status">
              <div v-if="missing(item).length > 0" class="text-caption text-warning">
                Missing: {{ missing(item).join(', ') }}
              </div>
              <div
                v-if="item.lastTest"
                class="text-caption"
                :class="item.lastTest.ok ? 'text-success' : 'text-error'"
                :title="item.lastTest.at"
              >
                {{ item.lastTest.summary }} · {{ ago(item.lastTest.at) }} ago
              </div>
              <div v-else class="text-caption text-medium-emphasis">not tested</div>
              <div v-if="testError[item.id]" class="text-caption text-error">
                {{ testError[item.id] }}
              </div>
            </td>
            <td class="text-right text-no-wrap">
              <v-btn
                variant="text"
                size="small"
                :prepend-icon="mdiLanConnect"
                :loading="testing === item.id"
                :disabled="testing !== null"
                data-test="connection-test"
                @click="test(item)"
              >
                Test connection
              </v-btn>
              <v-btn
                variant="text"
                size="small"
                :icon="mdiPencil"
                :aria-label="`Edit ${item.name}`"
                data-test="connection-edit"
                @click="startEdit(item)"
              />
              <v-btn
                variant="text"
                size="small"
                color="error"
                :icon="mdiDelete"
                :aria-label="`Delete ${item.name}`"
                @click="askDelete(item)"
              />
            </td>
          </tr>
        </tbody>
      </v-table>
    </v-card>

    <ConnectionDialog
      v-model="dialog"
      :types="types"
      :agents="agents"
      :projects="projects"
      :project-id="projectId"
      :is-owner="isOwner"
      :editing="editing"
      @saved="upsert"
    />

    <AdminConfirmDialog
      v-model="deleteOpen"
      :title="`Delete ${deleting?.name ?? ''}?`"
      confirm-text="Delete"
      color="error"
      :loading="deleteBusy"
      :error="deleteError"
      :consequences="[
        'The connection and its stored credentials are removed.',
        'Later runs no longer get its tools.',
      ]"
      @confirm="confirmDelete"
    />
  </div>
</template>

<style scoped>
.connection-url {
  overflow-wrap: anywhere;
  max-width: 320px;
}
</style>
