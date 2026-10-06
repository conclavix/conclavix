<script setup lang="ts">
import { ref, watch } from 'vue';
import { errorText } from '../../agents/api';
import { createPayload, emptyForm } from '../../agents/form';
import { api } from '../../api/client';
import type { Agent, AgentDetail } from '../../api/types';
import AgentFormFields from './AgentFormFields.vue';

const open = defineModel<boolean>({ required: true });
defineProps<{ agents: Agent[]; models: string[] }>();
const emit = defineEmits<{ created: [agent: AgentDetail] }>();

const form = ref(emptyForm());
const formRef = ref<{ validate: () => Promise<{ valid: boolean }> } | null>(null);
const saving = ref(false);
const error = ref('');

watch(open, (isOpen) => {
  if (isOpen) {
    form.value = emptyForm();
    error.value = '';
  }
});

async function submit(): Promise<void> {
  if (!(await formRef.value?.validate())?.valid) return;
  saving.value = true;
  error.value = '';
  try {
    const agent = await api<AgentDetail>('/agents', {
      method: 'POST',
      body: JSON.stringify(createPayload(form.value)),
    });
    open.value = false;
    emit('created', agent);
  } catch (cause) {
    error.value = errorText(cause);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="760" scrollable>
    <v-card title="New agent">
      <v-card-text>
        <v-form ref="formRef" @submit.prevent="submit">
          <AgentFormFields v-model="form" :agents="agents" :models="models" show-instructions />
        </v-form>
        <v-alert v-if="error" type="error" variant="tonal" class="mt-2">{{ error }}</v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="open = false">Cancel</v-btn>
        <v-btn color="primary" variant="flat" :loading="saving" @click="submit">Create</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
