<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api } from '../api/client';
import type { IssueDetail, ProjectAgent } from '../api/types';
import {
  BOARD_COLUMNS,
  PRIORITIES,
  describeError,
  issuePatch,
  toIssueForm,
  wakesAgent,
  type IssueForm,
} from '../issues';
import AgentSelect from './AgentSelect.vue';
import IssuePicker from './IssuePicker.vue';

const props = defineProps<{ issue: IssueDetail }>();
const emit = defineEmits<{ updated: [issue: IssueDetail] }>();

const form = ref<IssueForm>(toIssueForm(props.issue));
const error = ref('');
const notice = ref('');
const saving = ref(false);
const statuses = BOARD_COLUMNS.map((column) => ({ value: column.status, title: column.title }));

watch(
  () => props.issue,
  (issue) => {
    form.value = toIssueForm(issue);
  },
);

const access = ref<ProjectAgent[] | null>(null);
/** Name of the saved assignee when it is no longer enabled in the issue's project. */
const assigneeDisabled = computed(() => {
  const agent = access.value?.find((item) => item.id === props.issue.assigneeAgentId);
  return agent && !agent.enabled ? agent.name : null;
});

const patch = computed(() => issuePatch(props.issue, form.value));
const dirty = computed(() => Object.keys(patch.value).length > 0);

async function save(): Promise<void> {
  saving.value = true;
  error.value = '';
  notice.value = '';
  const changes = patch.value;
  try {
    const updated = await api<IssueDetail>(`/issues/${props.issue.key}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    });
    if (wakesAgent(props.issue.assigneeAgentId, changes.assigneeAgentId)) {
      notice.value = 'Assigned: the agent is woken and starts a run on this issue.';
    }
    emit('updated', updated);
  } catch (cause) {
    error.value = describeError(cause);
  } finally {
    saving.value = false;
  }
}

function reset(): void {
  form.value = toIssueForm(props.issue);
  error.value = '';
}
</script>

<template>
  <v-card title="Details" data-test="issue-fields">
    <v-card-text class="d-flex flex-column ga-1">
      <v-select v-model="form.status" :items="statuses" label="Status" density="compact" />
      <v-select v-model="form.priority" :items="PRIORITIES" label="Priority" density="compact" />
      <AgentSelect
        v-model="form.assigneeAgentId"
        :project-id="issue.projectId"
        :current="issue.assigneeAgentId"
        @access="access = $event"
      />
      <v-alert
        v-if="assigneeDisabled"
        type="warning"
        variant="tonal"
        density="compact"
        data-test="assignee-disabled"
      >
        {{ assigneeDisabled }} is not enabled in this project. The issue stays assigned but is not
        worked on; reassign it or enable the agent on the project's Agents tab.
      </v-alert>
      <v-alert
        v-if="form.assigneeAgentId && form.assigneeAgentId !== issue.assigneeAgentId"
        type="info"
        variant="tonal"
        density="compact"
      >
        Saving wakes the newly assigned agent.
      </v-alert>
      <v-combobox
        v-model="form.labels"
        label="Labels"
        multiple
        chips
        closable-chips
        density="compact"
      />
      <IssuePicker
        v-model="form.parentId"
        label="Parent issue"
        :project-id="issue.projectId"
        :exclude="[issue.id]"
      />
      <IssuePicker v-model="form.blockedBy" label="Blocked by" multiple :exclude="[issue.id]" />
      <v-alert v-if="error" type="error" variant="tonal" density="compact" data-test="issue-error">
        {{ error }}
      </v-alert>
      <v-alert v-if="notice" type="success" variant="tonal" density="compact" closable>
        {{ notice }}
      </v-alert>
    </v-card-text>
    <v-card-actions>
      <v-spacer />
      <v-btn :disabled="!dirty" @click="reset">Reset</v-btn>
      <v-btn color="primary" :disabled="!dirty" :loading="saving" @click="save">Save</v-btn>
    </v-card-actions>
  </v-card>
</template>
