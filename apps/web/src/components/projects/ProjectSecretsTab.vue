<script setup lang="ts">
import { mdiDelete, mdiEyeOutline, mdiKeyVariant, mdiPencil, mdiPlus } from '@mdi/js';
import { computed, ref, watch } from 'vue';
import { secretsApi, type Secret, type SecretAgent } from '../../api/secrets';
import { ago } from '../../format';
import {
  draftOf,
  emptySecretDraft,
  envNameRules,
  secretErrorText,
  secretPayload,
  suggestEnvName,
  valueRules,
  type SecretDraft,
} from '../../secrets/form';
import AdminConfirmDialog from '../admin/AdminConfirmDialog.vue';
import SecretRevealDialog from './SecretRevealDialog.vue';

const props = defineProps<{ projectId: string; isOwner: boolean }>();

const secrets = ref<Secret[]>([]);
const agents = ref<SecretAgent[]>([]);
const loading = ref(false);
const loadError = ref('');

const dialog = ref(false);
const editing = ref<Secret | null>(null);
const draft = ref<SecretDraft>(emptySecretDraft());
const envTouched = ref(false);
const saving = ref(false);
const saveError = ref('');
const form = ref<{ validate(): Promise<{ valid: boolean }> } | null>(null);

const deleting = ref<Secret | null>(null);
const deleteOpen = ref(false);
const deleteBusy = ref(false);
const deleteError = ref('');

const revealing = ref<Secret | null>(null);
const revealOpen = ref(false);

const agentName = computed(() => new Map(agents.value.map((agent) => [agent.id, agent])));
const agentItems = computed(() =>
  agents.value.map((agent) => ({
    title: agent.name,
    value: agent.id,
    subtitle: agent.codeAccess === 'write' ? 'code access' : 'read-only: receives no secrets',
  })),
);
const selectedReadOnly = computed(() =>
  draft.value.agentIds
    .map((id) => agentName.value.get(id))
    .filter((agent): agent is SecretAgent => agent?.codeAccess === 'none'),
);

async function load(): Promise<void> {
  const projectId = props.projectId;
  loading.value = true;
  loadError.value = '';
  try {
    const result = await secretsApi.list(projectId);
    if (props.projectId !== projectId) return;
    secrets.value = result.items;
    agents.value = result.agents;
  } catch (cause) {
    if (props.projectId === projectId) loadError.value = secretErrorText(cause);
  } finally {
    if (props.projectId === projectId) loading.value = false;
  }
}
watch(() => props.projectId, load, { immediate: true });

watch(
  () => draft.value.name,
  (name) => {
    if (!editing.value && !envTouched.value) draft.value.envName = suggestEnvName(name);
  },
);

function startCreate(): void {
  editing.value = null;
  draft.value = emptySecretDraft();
  envTouched.value = false;
  saveError.value = '';
  dialog.value = true;
}

function startEdit(secret: Secret): void {
  editing.value = secret;
  draft.value = draftOf(secret);
  envTouched.value = true;
  saveError.value = '';
  dialog.value = true;
}

async function save(): Promise<void> {
  if (saving.value) return;
  if (!(await form.value?.validate())?.valid) return;
  saving.value = true;
  saveError.value = '';
  try {
    const body = secretPayload(draft.value, editing.value);
    const saved = editing.value
      ? Object.keys(body).length > 0
        ? await secretsApi.update(props.projectId, editing.value.id, body)
        : editing.value
      : await secretsApi.create(props.projectId, body);
    secrets.value = [...secrets.value.filter((secret) => secret.id !== saved.id), saved].sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    dialog.value = false;
  } catch (cause) {
    saveError.value = secretErrorText(cause);
  } finally {
    draft.value.value = '';
    saving.value = false;
  }
}

function askDelete(secret: Secret): void {
  deleting.value = secret;
  deleteError.value = '';
  deleteOpen.value = true;
}

async function confirmDelete(): Promise<void> {
  const secret = deleting.value;
  if (!secret) return;
  deleteBusy.value = true;
  deleteError.value = '';
  try {
    await secretsApi.remove(props.projectId, secret.id);
    secrets.value = secrets.value.filter((entry) => entry.id !== secret.id);
    deleteOpen.value = false;
  } catch (cause) {
    deleteError.value = secretErrorText(cause);
  } finally {
    deleteBusy.value = false;
  }
}

function askReveal(secret: Secret): void {
  revealing.value = secret;
  revealOpen.value = true;
}
</script>

<template>
  <div data-test="project-secrets">
    <div class="d-flex align-start flex-wrap ga-2 mb-2">
      <p class="text-body-2 text-medium-emphasis flex-1-1 ma-0" style="min-width: 260px">
        Values coding agents get as environment variables in their sandboxed runs on this project's
        issues, for example an API key for tests. Only the agents you select receive a secret, and
        only agents with code access do: read-only agents never get secrets. Values are stored
        encrypted and removed from run logs; only owners can show them again.
      </p>
      <v-btn color="primary" :prepend-icon="mdiPlus" data-test="secret-add" @click="startCreate">
        Add secret
      </v-btn>
    </div>
    <v-alert v-if="loadError" type="error" variant="tonal" density="compact" class="mb-2">
      {{ loadError }}
    </v-alert>
    <v-progress-linear v-if="loading" indeterminate class="mb-2" />
    <v-card v-if="!loading && !loadError && secrets.length === 0" variant="outlined" class="pa-6">
      <div class="d-flex align-center ga-3 text-medium-emphasis">
        <v-icon :icon="mdiKeyVariant" />
        No secrets in this project yet.
      </div>
    </v-card>
    <v-card v-if="secrets.length > 0" variant="outlined">
      <v-table density="comfortable">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Variable</th>
            <th scope="col">Agents</th>
            <th scope="col">Updated</th>
            <th scope="col">Last used</th>
            <th scope="col" class="text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="secret in secrets" :key="secret.id" :data-test="`secret-${secret.envName}`">
            <td class="font-weight-medium">{{ secret.name }}</td>
            <td>
              <code>{{ secret.envName }}</code>
            </td>
            <td>
              <div class="d-flex flex-wrap ga-1 py-1">
                <v-chip
                  v-for="id in secret.agentIds"
                  :key="id"
                  size="small"
                  variant="tonal"
                  :color="agentName.get(id)?.codeAccess === 'write' ? 'primary' : undefined"
                  :title="
                    agentName.get(id)?.codeAccess === 'write'
                      ? 'Receives it in coding runs'
                      : 'Read-only agent: receives no secrets'
                  "
                >
                  {{ agentName.get(id)?.name ?? 'deleted agent' }}
                </v-chip>
                <span v-if="secret.agentIds.length === 0" class="text-medium-emphasis">none</span>
              </div>
            </td>
            <td class="text-no-wrap" :title="secret.updatedAt">{{ ago(secret.updatedAt) }} ago</td>
            <td class="text-no-wrap">
              <router-link
                v-if="secret.lastUsedAt && secret.lastUsedRunId"
                :to="{ name: 'run', params: { runId: secret.lastUsedRunId } }"
                :title="secret.lastUsedAt"
              >
                {{ ago(secret.lastUsedAt) }} ago
              </router-link>
              <span v-else class="text-medium-emphasis">never</span>
            </td>
            <td class="text-right text-no-wrap">
              <v-btn
                v-if="isOwner"
                variant="text"
                size="small"
                :icon="mdiEyeOutline"
                :aria-label="`Show ${secret.envName}`"
                data-test="secret-reveal"
                @click="askReveal(secret)"
              />
              <v-btn
                variant="text"
                size="small"
                :icon="mdiPencil"
                :aria-label="`Edit ${secret.envName}`"
                data-test="secret-edit"
                @click="startEdit(secret)"
              />
              <v-btn
                variant="text"
                size="small"
                color="error"
                :icon="mdiDelete"
                :aria-label="`Delete ${secret.envName}`"
                @click="askDelete(secret)"
              />
            </td>
          </tr>
        </tbody>
      </v-table>
    </v-card>

    <v-dialog v-model="dialog" max-width="560" :persistent="saving">
      <v-card :title="editing ? `Edit ${editing.envName}` : 'Add secret'">
        <v-card-text>
          <v-form ref="form" :disabled="saving" @submit.prevent="save">
            <v-text-field
              v-model="draft.name"
              label="Name"
              :rules="[(v: string) => v.trim().length > 0 || 'required']"
              data-test="secret-name"
              class="mb-2"
            />
            <v-text-field
              v-model="draft.envName"
              label="Environment variable"
              :rules="envNameRules"
              hint="The name the agent's commands see, e.g. STRIPE_TEST_KEY"
              persistent-hint
              data-test="secret-env-name"
              class="mb-2"
              @update:model-value="envTouched = true"
            />
            <v-text-field
              v-model="draft.value"
              label="Value"
              type="password"
              autocomplete="new-password"
              :rules="valueRules(editing === null)"
              :hint="
                editing
                  ? 'Leave empty to keep the stored value; anything entered replaces it.'
                  : 'Stored encrypted. It is not shown again after saving.'
              "
              persistent-hint
              data-test="secret-value"
              class="mb-4"
            />
            <v-autocomplete
              v-model="draft.agentIds"
              :items="agentItems"
              label="Agents that receive it"
              multiple
              chips
              closable-chips
              data-test="secret-agents"
            >
              <template #item="{ props: itemProps, item }">
                <v-list-item v-bind="itemProps" :subtitle="item.subtitle" />
              </template>
            </v-autocomplete>
            <v-alert
              v-if="selectedReadOnly.length > 0"
              type="info"
              variant="tonal"
              density="compact"
              class="mt-2"
            >
              {{ selectedReadOnly.map((agent) => agent.name).join(', ') }}
              {{ selectedReadOnly.length === 1 ? 'has' : 'have' }} no code access and will not
              receive this secret until code access is granted.
            </v-alert>
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
            data-test="secret-save"
            @click="save"
          >
            Save
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <SecretRevealDialog v-model="revealOpen" :project-id="projectId" :secret="revealing" />

    <AdminConfirmDialog
      v-model="deleteOpen"
      :title="`Delete ${deleting?.envName ?? ''}?`"
      confirm-text="Delete"
      color="error"
      :loading="deleteBusy"
      :error="deleteError"
      :consequences="[
        'The secret and its stored value are removed.',
        'Later runs of the selected agents no longer get the variable.',
      ]"
      @confirm="confirmDelete"
    />
  </div>
</template>
