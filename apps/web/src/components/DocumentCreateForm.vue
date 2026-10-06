<script setup lang="ts">
import { ref } from 'vue';
import { api } from '../api/client';
import type { DocumentRevision } from '../api/types';
import { describeError } from '../issues';
import MarkdownField from './MarkdownField.vue';

const props = defineProps<{ issueKey: string; taken: string[] }>();
const emit = defineEmits<{ created: [key: string]; cancel: [] }>();

const key = ref('');
const title = ref('');
const body = ref('');
const error = ref('');
const saving = ref(false);
const keyRule = (value: string): true | string =>
  /^[a-z][a-z0-9-]{0,47}$/.test(value) || '1-48 lowercase letters, digits or dashes';

async function submit(): Promise<void> {
  if (props.taken.includes(key.value)) {
    error.value = `A document with key "${key.value}" already exists`;
    return;
  }
  saving.value = true;
  error.value = '';
  try {
    const doc = await api<DocumentRevision>(`/issues/${props.issueKey}/documents/${key.value}`, {
      method: 'PUT',
      body: JSON.stringify({
        ...(title.value.trim() ? { title: title.value } : {}),
        body: body.value,
      }),
    });
    emit('created', doc.key);
  } catch (cause) {
    error.value = describeError(cause);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <v-card title="New document" data-test="document-create">
    <v-card-text class="d-flex flex-column ga-2">
      <div class="d-flex ga-2">
        <v-text-field v-model="key" label="Key" :rules="[keyRule]" hint="e.g. plan" />
        <v-text-field v-model="title" label="Title (defaults to the key)" />
      </div>
      <MarkdownField v-model="body" label="Body (Markdown)" :rows="10" />
      <v-alert v-if="error" type="error" variant="tonal" density="compact">{{ error }}</v-alert>
    </v-card-text>
    <v-card-actions>
      <v-spacer />
      <v-btn @click="emit('cancel')">Cancel</v-btn>
      <v-btn color="primary" :loading="saving" @click="submit">Create</v-btn>
    </v-card-actions>
  </v-card>
</template>
