<script setup lang="ts">
import { mdiPlus } from '@mdi/js';
import { computed, ref, watch } from 'vue';
import { connectionsApi, type Connection, type ConnectionTypeInfo } from '../../api/connections';
import type { SecretAgent } from '../../api/secrets';
import {
  configFields,
  connectionErrorText,
  connectionPayload,
  draftOf,
  emptyDraft,
  nameRules,
  syncCredentialRows,
  type ConnectionDraft,
} from '../../connections/form';

const props = defineProps<{
  types: ConnectionTypeInfo[];
  agents: SecretAgent[];
  projects: { id: string; key: string; name: string }[];
  /** Set on a project page: new connections belong to this project. */
  projectId: string | null;
  isOwner: boolean;
  editing: Connection | null;
}>();
const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ saved: [connection: Connection] }>();

const draft = ref<ConnectionDraft | null>(null);
const saving = ref(false);
const error = ref('');
const newHeader = ref('');
const form = ref<{ validate(): Promise<{ valid: boolean }> } | null>(null);

const type = computed(() => props.types.find((entry) => entry.id === draft.value?.type) ?? null);
const fields = computed(() => (type.value ? configFields(type.value) : []));
const typeItems = computed(() =>
  props.types.map((entry) => ({ title: entry.label, value: entry.id })),
);
const projectItems = computed(() =>
  props.projects.map((project) => ({
    title: `${project.key} · ${project.name}`,
    value: project.id,
  })),
);
const agentItems = computed(() =>
  props.agents.map((agent) => ({
    title: agent.name,
    value: agent.id,
    subtitle: agent.codeAccess === 'write' ? 'coding agent' : 'read-only agent',
  })),
);
/** An admin may not change what an owner opened to private networks, except the agents. */
const lockedForAdmin = computed(
  () => !props.isOwner && props.editing?.allowPrivateNetwork === true,
);

watch(open, (value) => {
  if (!value) return;
  error.value = '';
  newHeader.value = '';
  const first = props.types[0];
  draft.value = props.editing
    ? draftOf(props.editing)
    : first
      ? emptyDraft(first, props.projectId)
      : null;
});

function changeType(id: string): void {
  const next = props.types.find((entry) => entry.id === id);
  if (next && draft.value)
    draft.value = { ...emptyDraft(next, props.projectId), name: draft.value.name };
}

function listOf(key: string): string[] {
  return (draft.value?.config[key] as string[] | undefined) ?? [];
}

function addListEntry(key: string): void {
  const value = newHeader.value.trim();
  if (!draft.value || !type.value || !value || listOf(key).includes(value)) return;
  draft.value.config[key] = [...listOf(key), value];
  newHeader.value = '';
  syncCredentialRows(draft.value, type.value);
}

function removeListEntry(key: string, value: string): void {
  if (!draft.value || !type.value) return;
  draft.value.config[key] = listOf(key).filter((entry) => entry !== value);
  syncCredentialRows(draft.value, type.value);
}

function setConfig(key: string, value: unknown): void {
  if (draft.value) draft.value.config[key] = value;
}

const required = (value: unknown) => (value !== '' && value !== undefined) || 'required';

async function save(): Promise<void> {
  if (!draft.value || !type.value || saving.value) return;
  if (!(await form.value?.validate())?.valid) return;
  saving.value = true;
  error.value = '';
  try {
    const body = connectionPayload(draft.value, type.value, props.editing);
    const saved = props.editing
      ? await connectionsApi.update(props.editing.id, body)
      : await connectionsApi.create(body);
    for (const row of draft.value.credentials) row.value = '';
    emit('saved', saved);
    open.value = false;
  } catch (cause) {
    error.value = connectionErrorText(cause);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="640" :persistent="saving" scrollable>
    <v-card v-if="draft" :title="editing ? `Edit ${editing.name}` : 'Add connection'">
      <v-card-text>
        <v-form ref="form" :disabled="saving" @submit.prevent="save">
          <v-select
            :model-value="draft.type"
            label="Type"
            :items="typeItems"
            :disabled="editing !== null"
            :hint="type?.description"
            persistent-hint
            class="mb-3"
            data-test="connection-type"
            @update:model-value="changeType"
          />
          <v-text-field
            v-model="draft.name"
            label="Name"
            :rules="nameRules"
            :disabled="lockedForAdmin"
            hint="Also the MCP server name; its tools appear as mcp__<name>__<tool>"
            persistent-hint
            class="mb-3"
            data-test="connection-name"
          />
          <v-select
            v-if="!editing && !projectId"
            v-model="draft.scope"
            label="Scope"
            :items="[
              { title: 'Instance: every project', value: 'instance' },
              { title: 'One project', value: 'project' },
            ]"
            class="mb-3"
          />
          <v-select
            v-if="!editing && !projectId && draft.scope === 'project'"
            v-model="draft.projectId"
            label="Project"
            :items="projectItems"
            :rules="[required]"
            class="mb-3"
          />
          <template v-for="field in fields" :key="field.key">
            <div v-if="field.kind === 'list' && field.key === type?.credentialsField" class="mb-3">
              <div class="text-subtitle-2">{{ field.title }}</div>
              <div class="text-caption text-medium-emphasis mb-2">{{ field.description }}</div>
              <div
                v-for="row in draft.credentials"
                :key="row.key"
                class="d-flex align-center ga-2 mb-2"
                :data-test="`connection-credential-${row.key}`"
              >
                <v-chip label class="flex-shrink-0">{{ row.key }}</v-chip>
                <v-text-field
                  v-model="row.value"
                  :label="type?.credentialLabel"
                  type="password"
                  autocomplete="new-password"
                  density="compact"
                  hide-details="auto"
                  :disabled="lockedForAdmin"
                  :placeholder="row.stored ? 'stored (leave empty to keep)' : 'required'"
                />
                <v-btn
                  variant="text"
                  size="small"
                  :disabled="lockedForAdmin"
                  @click="removeListEntry(field.key, row.key)"
                >
                  Remove
                </v-btn>
              </div>
              <div class="d-flex align-center ga-2">
                <v-text-field
                  v-model="newHeader"
                  label="Name to add"
                  density="compact"
                  hide-details
                  :disabled="lockedForAdmin"
                  data-test="connection-new-header"
                  @keydown.enter.prevent="addListEntry(field.key)"
                />
                <v-btn
                  :prepend-icon="mdiPlus"
                  variant="tonal"
                  :disabled="lockedForAdmin"
                  data-test="connection-add-header"
                  @click="addListEntry(field.key)"
                >
                  Add
                </v-btn>
              </div>
            </div>
            <v-switch
              v-else-if="field.kind === 'boolean'"
              v-model="draft.config[field.key]"
              :label="field.title"
              :hint="field.description"
              persistent-hint
              color="primary"
              :disabled="lockedForAdmin"
              class="mb-3"
            />
            <v-select
              v-else-if="field.kind === 'choice'"
              :model-value="String(draft.config[field.key] ?? '')"
              @update:model-value="(value: string) => setConfig(field.key, value)"
              :label="field.title"
              :items="field.options"
              :hint="field.description"
              persistent-hint
              :disabled="lockedForAdmin"
              class="mb-3"
            />
            <v-text-field
              v-else-if="field.kind !== 'list'"
              v-model="draft.config[field.key]"
              :label="field.title"
              :type="field.kind === 'number' ? 'number' : 'text'"
              :hint="field.description"
              persistent-hint
              :rules="field.required ? [required] : []"
              :disabled="lockedForAdmin"
              class="mb-3"
              :data-test="`connection-field-${field.key}`"
            />
          </template>
          <v-autocomplete
            v-model="draft.agentIds"
            :items="agentItems"
            label="Agents that may use it"
            multiple
            chips
            closable-chips
            hint="Read-only and coding agents both get its tools in their runs"
            persistent-hint
            class="mb-3"
            data-test="connection-agents"
          >
            <template #item="{ props: itemProps, item }">
              <v-list-item v-bind="itemProps" :subtitle="item.subtitle" />
            </template>
          </v-autocomplete>
          <v-checkbox
            v-model="draft.allowPrivateNetwork"
            :disabled="!isOwner"
            label="Allow private networks (owners only)"
            :hint="
              isOwner
                ? 'Lets this connection reach private, loopback and link-local addresses, e.g. a server on your LAN. Coding runs also need the range in the sandbox configuration.'
                : 'Only an owner can allow private, loopback and link-local addresses.'
            "
            persistent-hint
            data-test="connection-private"
          />
          <v-alert v-if="lockedForAdmin" type="info" variant="tonal" density="compact" class="mt-3">
            An owner allowed private networks for this connection; you can change its agents only.
          </v-alert>
          <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-3">
            {{ error }}
          </v-alert>
        </v-form>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" :disabled="saving" @click="open = false">Cancel</v-btn>
        <v-btn
          color="primary"
          variant="flat"
          :loading="saving"
          data-test="connection-save"
          @click="save"
        >
          Save
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
