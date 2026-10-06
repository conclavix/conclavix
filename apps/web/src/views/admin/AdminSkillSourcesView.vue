<script setup lang="ts">
import { mdiDelete, mdiPencil, mdiPlus, mdiLanConnect } from '@mdi/js';
import { computed, onMounted, ref } from 'vue';
import AdminConfirmDialog from '../../components/admin/AdminConfirmDialog.vue';
import {
  skillSourcesApi,
  type DirectoryStatus,
  type ProviderInfo,
  type SkillSource,
} from '../../api/skill-sources';
import {
  directoryErrorText,
  providerLabel,
  quotaText,
  sourcePayload,
  type SourceDraft,
} from '../../skills/directory';

const sources = ref<SkillSource[]>([]);
const providers = ref<ProviderInfo[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);

const dialog = ref(false);
const editing = ref<SkillSource | null>(null);
const draft = ref<SourceDraft>(emptyDraft());
const saving = ref(false);
const saveError = ref<string | null>(null);
const form = ref<{ validate(): Promise<{ valid: boolean }> } | null>(null);

const deleting = ref<SkillSource | null>(null);
const deleteOpen = ref(false);
const deleteBusy = ref(false);
const deleteError = ref<string | null>(null);

const testing = ref<string | null>(null);
const results = ref<
  Record<string, { ok: true; status: DirectoryStatus } | { ok: false; error: string }>
>({});

const providerItems = computed(() =>
  providers.value.map((provider) => ({ title: provider.label, value: provider.id })),
);
/** The stored key never follows a changed endpoint; the server drops it unless a new one is sent. */
const urlChanged = computed(
  () =>
    editing.value !== null &&
    draft.value.baseUrl.trim() !== (editing.value.baseUrlIsDefault ? '' : editing.value.baseUrl),
);
const providerInfo = computed(() =>
  providers.value.find((provider) => provider.id === draft.value.provider),
);

function emptyDraft(): SourceDraft {
  return {
    name: '',
    provider: 'skillsdirectory',
    baseUrl: '',
    apiKey: '',
    removeKey: false,
    enabled: true,
  };
}

const nameRules = [
  (value: string) => value.trim().length > 0 || 'required',
  (value: string) => value.trim().length <= 80 || 'at most 80 characters',
];
const urlRules = [
  (value: string) => {
    if (!value.trim()) return true;
    try {
      return /^https?:$/.test(new URL(value.trim()).protocol) || 'must be an https:// URL';
    } catch {
      return 'must be a URL';
    }
  },
];
const keyRules = [
  (value: string) => /^[\x21-\x7e]*$/.test(value) || 'no spaces or control characters',
  (value: string) => value.length <= 512 || 'at most 512 characters',
];

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    const result = await skillSourcesApi.list();
    sources.value = result.items;
    providers.value = result.providers;
  } catch (cause) {
    loadError.value = directoryErrorText(cause);
  } finally {
    loading.value = false;
  }
}

function startCreate(): void {
  editing.value = null;
  draft.value = emptyDraft();
  saveError.value = null;
  dialog.value = true;
}

function startEdit(source: SkillSource): void {
  editing.value = source;
  draft.value = {
    name: source.name,
    provider: source.provider,
    baseUrl: source.baseUrlIsDefault ? '' : source.baseUrl,
    apiKey: '',
    removeKey: false,
    enabled: source.enabled,
  };
  saveError.value = null;
  dialog.value = true;
}

async function save(): Promise<void> {
  if (saving.value) return;
  if (!(await form.value?.validate())?.valid) return;
  saving.value = true;
  saveError.value = null;
  try {
    const body = sourcePayload(draft.value, editing.value);
    const saved = editing.value
      ? await skillSourcesApi.update(editing.value.id, body)
      : await skillSourcesApi.create(body);
    sources.value = [...sources.value.filter((source) => source.id !== saved.id), saved].sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    results.value = Object.fromEntries(
      Object.entries(results.value).filter(([id]) => id !== saved.id),
    );
    dialog.value = false;
  } catch (cause) {
    saveError.value = directoryErrorText(cause);
  } finally {
    draft.value.apiKey = '';
    saving.value = false;
  }
}

function askDelete(source: SkillSource): void {
  deleting.value = source;
  deleteError.value = null;
  deleteOpen.value = true;
}

async function confirmDelete(): Promise<void> {
  const source = deleting.value;
  if (!source) return;
  deleteBusy.value = true;
  deleteError.value = null;
  try {
    await skillSourcesApi.remove(source.id);
    sources.value = sources.value.filter((entry) => entry.id !== source.id);
    deleteOpen.value = false;
  } catch (cause) {
    deleteError.value = directoryErrorText(cause);
  } finally {
    deleteBusy.value = false;
  }
}

async function test(source: SkillSource): Promise<void> {
  testing.value = source.id;
  try {
    const status = await skillSourcesApi.test(source.id);
    results.value = { ...results.value, [source.id]: { ok: true, status } };
  } catch (cause) {
    results.value = {
      ...results.value,
      [source.id]: { ok: false, error: directoryErrorText(cause) },
    };
  } finally {
    testing.value = null;
  }
}

function statusText(status: DirectoryStatus): string {
  const parts = [`Connected${status.tier ? ` (${status.tier} plan)` : ''}`];
  const quota = quotaText({ ...status.quota, tier: null });
  if (quota) parts.push(quota);
  return parts.join(' · ');
}

onMounted(load);
</script>

<template>
  <v-container fluid class="pa-3">
    <v-card>
      <v-card-title class="d-flex align-center">
        Skill directories
        <v-spacer />
        <v-btn color="primary" :prepend-icon="mdiPlus" data-test="source-add" @click="startCreate">
          Add directory
        </v-btn>
      </v-card-title>
      <v-card-subtitle class="text-wrap">
        External directories admins can browse and import skills from on the
        <router-link :to="{ name: 'skills', query: { tab: 'directory' } }">Skills</router-link>
        page. API keys are stored encrypted and never shown again.
      </v-card-subtitle>
      <v-progress-linear v-if="loading" indeterminate />
      <v-alert v-if="loadError" type="error" variant="tonal" class="ma-4">{{ loadError }}</v-alert>
      <v-card-text
        v-if="!loading && !loadError && sources.length === 0"
        class="text-medium-emphasis"
      >
        No directories yet. Add one to browse its skills.
      </v-card-text>
      <v-table v-if="sources.length > 0" density="comfortable">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Provider</th>
            <th scope="col">Endpoint</th>
            <th scope="col">API key</th>
            <th scope="col">Status</th>
            <th scope="col" class="text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="source in sources" :key="source.id" :data-test="`source-${source.id}`">
            <td class="font-weight-medium">{{ source.name }}</td>
            <td>{{ providerLabel(source.provider) }}</td>
            <td class="text-caption">
              {{ source.baseUrl }}
              <span v-if="source.baseUrlIsDefault" class="text-medium-emphasis">(default)</span>
            </td>
            <td>
              <v-chip
                size="small"
                :color="source.hasApiKey ? 'success' : undefined"
                variant="tonal"
              >
                {{ source.hasApiKey ? 'set' : 'not set' }}
              </v-chip>
            </td>
            <td>
              <v-chip size="small" :color="source.enabled ? 'primary' : undefined" variant="tonal">
                {{ source.enabled ? 'enabled' : 'disabled' }}
              </v-chip>
              <div
                v-if="results[source.id]"
                class="text-caption mt-1"
                :class="results[source.id]?.ok ? 'text-success' : 'text-error'"
                data-test="source-test-result"
              >
                <template v-if="results[source.id]?.ok">
                  {{ statusText((results[source.id] as { status: DirectoryStatus }).status) }}
                </template>
                <template v-else>{{ (results[source.id] as { error: string }).error }}</template>
              </div>
            </td>
            <td class="text-right text-no-wrap">
              <v-btn
                variant="text"
                size="small"
                :prepend-icon="mdiLanConnect"
                :loading="testing === source.id"
                :disabled="testing !== null"
                data-test="source-test"
                @click="test(source)"
              >
                Test connection
              </v-btn>
              <v-btn
                variant="text"
                size="small"
                :icon="mdiPencil"
                :aria-label="`Edit ${source.name}`"
                @click="startEdit(source)"
              />
              <v-btn
                variant="text"
                size="small"
                color="error"
                :icon="mdiDelete"
                :aria-label="`Delete ${source.name}`"
                @click="askDelete(source)"
              />
            </td>
          </tr>
        </tbody>
      </v-table>
    </v-card>

    <v-dialog v-model="dialog" max-width="560" :persistent="saving">
      <v-card :title="editing ? `Edit ${editing.name}` : 'Add skill directory'">
        <v-card-text>
          <v-form ref="form" :disabled="saving" @submit.prevent="save">
            <v-text-field v-model="draft.name" label="Name" :rules="nameRules" class="mb-2" />
            <v-select
              v-model="draft.provider"
              label="Provider"
              :items="providerItems"
              :disabled="editing !== null"
              class="mb-2"
            />
            <v-text-field
              v-model="draft.baseUrl"
              label="API base URL"
              :placeholder="providerInfo?.defaultBaseUrl"
              hint="Empty uses the provider default. Public https URLs only."
              persistent-hint
              :rules="urlRules"
              class="mb-2"
            />
            <v-text-field
              v-model="draft.apiKey"
              label="API key"
              type="password"
              autocomplete="new-password"
              :rules="keyRules"
              :disabled="draft.removeKey"
              :hint="
                editing?.hasApiKey && urlChanged
                  ? 'Changing the URL removes the stored key; enter it again to keep using one.'
                  : editing?.hasApiKey
                    ? 'A key is stored. Leave empty to keep it.'
                    : 'Optional for some directories; it is stored encrypted.'
              "
              persistent-hint
              data-test="source-api-key"
              class="mb-2"
            />
            <v-checkbox
              v-if="editing?.hasApiKey"
              v-model="draft.removeKey"
              label="Remove the stored API key"
              density="compact"
              hide-details
            />
            <v-switch v-model="draft.enabled" label="Enabled" color="primary" hide-details />
            <p v-if="providerInfo" class="text-caption text-medium-emphasis mt-2">
              API documentation:
              <a :href="providerInfo.docsUrl" target="_blank" rel="noopener noreferrer">{{
                providerInfo.docsUrl
              }}</a>
            </p>
            <v-alert v-if="saveError" type="error" variant="tonal" density="compact" class="mt-3">
              {{ saveError }}
            </v-alert>
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" :disabled="saving" @click="dialog = false">Cancel</v-btn>
          <v-btn
            color="primary"
            variant="flat"
            :loading="saving"
            data-test="source-save"
            @click="save"
          >
            Save
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <AdminConfirmDialog
      v-model="deleteOpen"
      :title="`Delete ${deleting?.name ?? ''}?`"
      confirm-text="Delete"
      color="error"
      :loading="deleteBusy"
      :error="deleteError"
      :consequences="[
        'The directory and its stored API key are removed.',
        'Skills already imported from it stay in the library.',
      ]"
      @confirm="confirmDelete"
    />
  </v-container>
</template>
