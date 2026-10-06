<script setup lang="ts">
import { mdiDeleteOutline } from '@mdi/js';
import { ref, watch } from 'vue';
import { errorText, patchAgent } from '../../agents/api';
import { formFromAgent, settingsPayload } from '../../agents/form';
import { api } from '../../api/client';
import type { Agent, AgentDetail } from '../../api/types';
import AgentFormFields from './AgentFormFields.vue';

const props = defineProps<{ agent: AgentDetail; agents: Agent[]; models: string[] }>();
const emit = defineEmits<{ updated: [agent: AgentDetail]; deleted: [] }>();

const form = ref(formFromAgent(props.agent));
// AgentView reuses this tab when it navigates to another agent; never save one agent's form onto another.
watch(
  () => props.agent.id,
  () => (form.value = formFromAgent(props.agent)),
);
const formRef = ref<{ validate: () => Promise<{ valid: boolean }> } | null>(null);
const saving = ref(false);
const switching = ref(false);
const confirmDelete = ref(false);
const deleting = ref(false);
const error = ref('');
const deleteError = ref('');
const saved = ref(false);

async function save(): Promise<void> {
  if (!(await formRef.value?.validate())?.valid) return;
  saving.value = true;
  error.value = '';
  try {
    const agent = await patchAgent(props.agent.id, settingsPayload(form.value));
    form.value = formFromAgent(agent);
    emit('updated', agent);
    saved.value = true;
  } catch (cause) {
    error.value = errorText(cause);
  } finally {
    saving.value = false;
  }
}

async function setStatus(active: boolean | null): Promise<void> {
  switching.value = true;
  error.value = '';
  try {
    emit('updated', await patchAgent(props.agent.id, { status: active ? 'active' : 'paused' }));
  } catch (cause) {
    error.value = errorText(cause);
  } finally {
    switching.value = false;
  }
}

async function remove(): Promise<void> {
  deleting.value = true;
  deleteError.value = '';
  try {
    await api(`/agents/${props.agent.id}`, { method: 'DELETE' });
    confirmDelete.value = false;
    emit('deleted');
  } catch (cause) {
    deleteError.value = errorText(cause);
  } finally {
    deleting.value = false;
  }
}

function askDelete(): void {
  deleteError.value = '';
  confirmDelete.value = true;
}
</script>

<template>
  <div>
    <v-switch
      :model-value="agent.status === 'active'"
      :loading="switching"
      color="success"
      :label="agent.status === 'active' ? 'Active: the scheduler wakes this agent' : 'Paused'"
      hide-details
      class="mb-2"
      @update:model-value="setStatus"
    />
    <v-form ref="formRef" @submit.prevent="save">
      <AgentFormFields v-model="form" :agents="agents" :models="models" :self-id="agent.id" />
    </v-form>
    <v-alert v-if="error" type="error" variant="tonal" class="my-2">{{ error }}</v-alert>
    <div class="d-flex align-center ga-2 mt-2">
      <v-btn color="primary" variant="flat" :loading="saving" @click="save">Save settings</v-btn>
      <v-spacer />
      <v-btn color="error" variant="outlined" :prepend-icon="mdiDeleteOutline" @click="askDelete">
        Delete agent
      </v-btn>
    </div>
    <v-snackbar v-model="saved" color="success" timeout="2000">Settings saved</v-snackbar>
    <v-dialog v-model="confirmDelete" max-width="480">
      <v-card :title="`Delete ${agent.name}?`">
        <v-card-text>
          This removes the agent for good. Agents with direct reports or open issues cannot be
          deleted; reassign those first.
          <v-alert v-if="deleteError" type="error" variant="tonal" class="mt-3">
            {{ deleteError }}
          </v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="confirmDelete = false">Cancel</v-btn>
          <v-btn color="error" variant="flat" :loading="deleting" @click="remove">Delete</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
