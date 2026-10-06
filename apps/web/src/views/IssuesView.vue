<script setup lang="ts">
import { mdiPlus } from '@mdi/js';
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { IssueDetail } from '../api/types';
import IssueBoard from '../components/IssueBoard.vue';
import IssueCreateDialog from '../components/IssueCreateDialog.vue';
import { BOARD_COLUMNS, describeError } from '../issues';
import { useBoardIssues } from '../stores/board';
import { useLiveStore } from '../stores/live';
import { useProjectsStore } from '../stores/projects';

const route = useRoute();
const router = useRouter();
const live = useLiveStore();
const projects = useProjectsStore();
const filter = ref<string | null>('');
const creating = ref(false);
const error = ref('');

const projectId = computed<string | null>({
  get: () => projects.items.find((p) => p.key === route.query['project'])?.id ?? null,
  set: (id) => {
    const key = id ? projects.byId[id]?.key : undefined;
    void router.replace({ query: key ? { project: key } : {} });
  },
});
const { issues, agentNames } = useBoardIssues(projectId, filter);

onMounted(() =>
  Promise.all([projects.load(), live.loadIssues()]).catch(
    (cause) => (error.value = describeError(cause)),
  ),
);

const opened = (issue: IssueDetail): void =>
  void router.push({ name: 'issue', params: { issueKey: issue.key } });
</script>

<template>
  <v-container fluid class="pa-3">
    <div class="d-flex align-center ga-2 mb-2">
      <v-select
        v-model="projectId"
        :items="projects.items"
        :item-title="(p) => `${p.key} · ${p.name}`"
        item-value="id"
        label="Project"
        density="compact"
        clearable
        hide-details
        style="max-width: 280px"
      />
      <v-text-field
        v-model="filter"
        label="Filter by key or title"
        density="compact"
        clearable
        hide-details
      />
      <v-btn color="primary" :prepend-icon="mdiPlus" @click="creating = true">New issue</v-btn>
    </div>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-2">{{ error }}</v-alert>
    <IssueBoard
      :issues="issues"
      :columns="BOARD_COLUMNS"
      :agent-names="agentNames"
      :projects="projectId ? undefined : projects.byId"
      :filtered="!!(filter ?? '').trim()"
      can-create
      @create="creating = true"
    />
    <IssueCreateDialog v-model="creating" :project-id="projectId ?? undefined" @created="opened" />
  </v-container>
</template>
