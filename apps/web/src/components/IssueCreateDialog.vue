<script setup lang="ts">
import { ref, watch } from 'vue';
import { api } from '../api/client';
import type { IssueDetail } from '../api/types';
import { PRIORITIES, cleanLabels, describeError } from '../issues';
import { useProjectsStore } from '../stores/projects';
import AgentSelect from './AgentSelect.vue';
import IssuePicker from './IssuePicker.vue';
import MarkdownField from './MarkdownField.vue';

const open = defineModel<boolean>({ required: true });
const props = defineProps<{ projectId?: string | undefined; parentId?: string | undefined }>();
const emit = defineEmits<{ created: [issue: IssueDetail] }>();

const projects = useProjectsStore();
const empty = () => ({
  projectId: props.projectId ?? null,
  title: '',
  description: '',
  priority: 'medium',
  assigneeAgentId: null as string | null,
  parentId: props.parentId ?? null,
  blockedBy: [] as string[],
  labels: [] as string[],
});
const form = ref(empty());
const error = ref('');
const saving = ref(false);

watch(open, (isOpen) => {
  if (!isOpen) return;
  form.value = empty();
  error.value = '';
  void projects.ensureLoaded().catch((cause) => (error.value = describeError(cause)));
});

async function submit(): Promise<void> {
  if (!form.value.projectId || !form.value.title.trim()) {
    error.value = 'Project and title are required';
    return;
  }
  saving.value = true;
  error.value = '';
  try {
    const issue = await api<IssueDetail>('/issues', {
      method: 'POST',
      body: JSON.stringify({
        ...form.value,
        title: form.value.title.trim(),
        labels: cleanLabels(form.value.labels),
      }),
    });
    open.value = false;
    emit('created', issue);
  } catch (cause) {
    error.value = describeError(cause);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="760" scrollable>
    <v-card :title="parentId ? 'New sub-issue' : 'New issue'" data-test="issue-create-dialog">
      <v-card-text class="d-flex flex-column ga-2">
        <v-select
          v-model="form.projectId"
          :items="projects.active"
          item-title="name"
          item-value="id"
          label="Project"
          :disabled="Boolean(projectId || parentId)"
        />
        <v-text-field v-model="form.title" label="Title" autofocus />
        <MarkdownField v-model="form.description" label="Description (Markdown)" />
        <div class="d-flex ga-2">
          <v-select v-model="form.priority" :items="PRIORITIES" label="Priority" />
          <AgentSelect v-model="form.assigneeAgentId" :project-id="form.projectId" />
        </div>
        <v-alert v-if="form.assigneeAgentId" type="info" variant="tonal" density="compact">
          Creating an assigned issue wakes the agent, which then starts a run.
        </v-alert>
        <IssuePicker
          v-if="form.projectId"
          v-model="form.parentId"
          label="Parent issue"
          :project-id="form.projectId"
        />
        <IssuePicker v-model="form.blockedBy" label="Blocked by" multiple />
        <v-combobox v-model="form.labels" label="Labels" multiple chips closable-chips />
        <v-alert v-if="error" type="error" variant="tonal" density="compact">{{ error }}</v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="open = false">Cancel</v-btn>
        <v-btn color="primary" :loading="saving" @click="submit">Create</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
