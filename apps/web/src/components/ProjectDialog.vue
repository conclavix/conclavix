<script setup lang="ts">
import { ref, watch } from 'vue';
import type { Project } from '../api/types';
import { describeError } from '../issues';
import { useProjectsStore } from '../stores/projects';

const open = defineModel<boolean>({ required: true });
const props = defineProps<{ project?: Project | null }>();
const emit = defineEmits<{ saved: [project: Project] }>();

const projects = useProjectsStore();
const form = ref({ key: '', name: '', description: '' });
const error = ref('');
const saving = ref(false);
const keyRule = (value: string): true | string =>
  /^[A-Z][A-Z0-9]{1,5}$/.test(value) || '2-6 uppercase letters or digits, starting with a letter';

watch(open, (isOpen) => {
  if (!isOpen) return;
  error.value = '';
  form.value = {
    key: props.project?.key ?? '',
    name: props.project?.name ?? '',
    description: props.project?.description ?? '',
  };
});

async function submit(): Promise<void> {
  saving.value = true;
  error.value = '';
  try {
    const { key, name, description } = form.value;
    const saved = props.project
      ? await projects.update(props.project.id, { name, description })
      : await projects.create({ key, name, description });
    open.value = false;
    emit('saved', saved);
  } catch (cause) {
    error.value = describeError(cause);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="560">
    <v-card :title="project ? `Edit ${project.key}` : 'New project'" data-test="project-dialog">
      <v-card-text class="d-flex flex-column ga-2">
        <v-text-field
          v-model="form.key"
          label="Key"
          :disabled="Boolean(project)"
          :rules="project ? [] : [keyRule]"
          :hint="project ? 'The key is part of every issue key and cannot change' : 'e.g. CVX'"
          persistent-hint
          @update:model-value="form.key = form.key.toUpperCase()"
        />
        <v-text-field v-model="form.name" label="Name" />
        <v-textarea v-model="form.description" label="Description (Markdown)" rows="3" auto-grow />
        <v-alert v-if="error" type="error" variant="tonal" density="compact">{{ error }}</v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="open = false">Cancel</v-btn>
        <v-btn color="primary" :loading="saving" @click="submit">Save</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
