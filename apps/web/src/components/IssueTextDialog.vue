<script setup lang="ts">
import { ref, watch } from 'vue';
import { api } from '../api/client';
import type { IssueDetail } from '../api/types';
import { describeError } from '../issues';
import MarkdownField from './MarkdownField.vue';

const open = defineModel<boolean>({ required: true });
const props = defineProps<{ issue: IssueDetail }>();
const emit = defineEmits<{ updated: [issue: IssueDetail] }>();

const title = ref('');
const description = ref('');
const error = ref('');
const saving = ref(false);

watch(open, (isOpen) => {
  if (!isOpen) return;
  title.value = props.issue.title;
  description.value = props.issue.description;
  error.value = '';
});

async function save(): Promise<void> {
  const changes: Record<string, string> = {};
  if (title.value.trim() !== props.issue.title) changes['title'] = title.value.trim();
  if (description.value !== props.issue.description) changes['description'] = description.value;
  if (Object.keys(changes).length === 0) {
    open.value = false;
    return;
  }
  saving.value = true;
  error.value = '';
  try {
    const updated = await api<IssueDetail>(`/issues/${props.issue.key}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    });
    open.value = false;
    emit('updated', updated);
  } catch (cause) {
    error.value = describeError(cause);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="860" scrollable>
    <v-card :title="`Edit ${issue.key}`">
      <v-card-text class="d-flex flex-column ga-2">
        <v-text-field v-model="title" label="Title" />
        <MarkdownField v-model="description" label="Description (Markdown)" :rows="10" />
        <v-alert v-if="error" type="error" variant="tonal" density="compact">{{ error }}</v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="open = false">Cancel</v-btn>
        <v-btn color="primary" :loading="saving" @click="save">Save</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
