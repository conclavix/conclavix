<script setup lang="ts">
import { mdiPencil, mdiPlus, mdiSourceBranch } from '@mdi/js';
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api/client';
import type { Issue, IssueDetail, Page, Run } from '../api/types';
import IssueComments from '../components/IssueComments.vue';
import IssueCreateDialog from '../components/IssueCreateDialog.vue';
import IssueDocuments from '../components/IssueDocuments.vue';
import IssueFieldsCard from '../components/IssueFieldsCard.vue';
import IssueTextDialog from '../components/IssueTextDialog.vue';
import MarkdownBlock from '../components/MarkdownBlock.vue';
import StatusChip from '../components/StatusChip.vue';
import { usd } from '../format';
import { PRIORITY_COLORS, describeError, statusTitle } from '../issues';
import { issueRepoContext, provideRepoContext } from '../repo-context';
import { applyEvent } from '../stores/reduce';
import { useLiveStore } from '../stores/live';
import { useProjectsStore } from '../stores/projects';

const props = defineProps<{ issueKey: string }>();
const router = useRouter();
const live = useLiveStore();
const projects = useProjectsStore();
const issue = ref<IssueDetail | null>(null);
const runs = ref<Run[]>([]);
const children = ref<Issue[]>([]);
const tab = ref('overview');
const editingText = ref(false);
const creatingChild = ref(false);
const error = ref('');

async function load(): Promise<void> {
  error.value = '';
  try {
    issue.value = await api<IssueDetail>(`/issues/${props.issueKey}`);
    const [issueRuns, kids] = await Promise.all([
      api<Page<Run>>(`/runs?issueId=${issue.value.id}&limit=20`),
      api<Page<Issue>>(`/issues?parentId=${issue.value.id}&limit=100`),
      projects.ensureLoaded(),
    ]);
    runs.value = issueRuns.items;
    children.value = kids.items;
  } catch (cause) {
    error.value = describeError(cause);
  }
}
watch(() => props.issueKey, load, { immediate: true });

const liveIssue = computed(() =>
  issue.value ? { ...issue.value, ...live.state.issues[issue.value.id] } : null,
);
const project = computed(() => (issue.value ? projects.byId[issue.value.projectId] : undefined));
provideRepoContext(() => issueRepoContext(liveIssue.value));

function updated(next: IssueDetail): void {
  issue.value = next;
  applyEvent(live.state, 'issue', { ...next });
}

function childCreated(child: IssueDetail): void {
  applyEvent(live.state, 'issue', { ...child });
  void router.push({ name: 'issue', params: { issueKey: child.key } });
}
</script>

<template>
  <v-container class="pa-3" style="max-width: 1200px">
    <v-alert v-if="error" type="error" variant="tonal">{{ error }}</v-alert>
    <template v-if="issue && liveIssue">
      <div class="d-flex align-center flex-wrap ga-2 mb-2">
        <router-link
          v-if="project"
          :to="{ name: 'project', params: { projectKey: project.key } }"
          class="text-medium-emphasis"
        >
          {{ project.name }}
        </router-link>
        <span class="text-h6" data-test="issue-title"
          >{{ liveIssue.key }} {{ liveIssue.title }}</span
        >
        <StatusChip :status="liveIssue.status">
          {{ statusTitle(liveIssue.status) }}
        </StatusChip>
        <v-chip :color="PRIORITY_COLORS[liveIssue.priority]">
          {{ liveIssue.priority }}
        </v-chip>
        <v-chip v-for="label in issue.labels" :key="label" variant="outlined">{{ label }}</v-chip>
        <v-chip v-if="liveIssue.checkoutRunId" color="primary">agent working</v-chip>
        <v-chip
          v-if="liveIssue.awaitingBoard"
          color="warning"
          :to="{ name: 'decisions' }"
          data-test="issue-awaiting-board"
        >
          awaiting board decision
        </v-chip>
        <v-chip
          v-if="issue.branch && project"
          :prepend-icon="mdiSourceBranch"
          variant="outlined"
          :to="{
            name: 'project',
            params: { projectKey: project.key },
            query: { tab: 'code', branch: issue.branch },
          }"
          data-test="issue-branch"
        >
          {{ issue.branch }}
        </v-chip>
        <v-spacer />
        <v-btn :prepend-icon="mdiPencil" variant="text" @click="editingText = true">Edit</v-btn>
      </div>
      <v-tabs v-model="tab" class="mb-3">
        <v-tab value="overview">Overview</v-tab>
        <v-tab value="documents">Documents</v-tab>
      </v-tabs>
      <v-row dense>
        <v-col cols="12" :md="tab === 'documents' ? 12 : 8">
          <IssueDocuments v-if="tab === 'documents'" :issue-key="issue.key" />
          <template v-else>
            <MarkdownBlock
              v-if="liveIssue.description"
              :source="liveIssue.description"
              class="mb-4"
            />
            <IssueComments :issue-key="issue.key" :issue-id="issue.id" />
          </template>
        </v-col>
        <v-col v-if="tab !== 'documents'" cols="12" md="4" class="d-flex flex-column ga-3">
          <IssueFieldsCard :issue="issue" @updated="updated" />
          <v-card>
            <v-card-title class="d-flex align-center">
              Sub-issues
              <v-spacer />
              <v-btn
                :prepend-icon="mdiPlus"
                size="small"
                variant="text"
                :disabled="project?.status === 'archived'"
                @click="creatingChild = true"
              >
                Sub-issue
              </v-btn>
            </v-card-title>
            <v-list density="compact">
              <v-list-item
                v-for="child in children"
                :key="child.id"
                :to="{ name: 'issue', params: { issueKey: child.key } }"
                :title="`${child.key} ${child.title}`"
                :subtitle="statusTitle(child.status)"
              />
              <v-list-item v-if="children.length === 0" subtitle="none" />
            </v-list>
          </v-card>
          <v-card title="Runs">
            <v-list density="compact">
              <v-list-item
                v-for="run in runs"
                :key="run.id"
                :to="{ name: 'live' }"
                :subtitle="usd(run.costUsd)"
              >
                <template #title>
                  <StatusChip :status="run.status" />
                  {{ run.reason }}
                </template>
              </v-list-item>
            </v-list>
          </v-card>
        </v-col>
      </v-row>
      <IssueTextDialog v-model="editingText" :issue="issue" @updated="updated" />
      <IssueCreateDialog
        v-model="creatingChild"
        :project-id="issue.projectId"
        :parent-id="issue.id"
        @created="childCreated"
      />
    </template>
  </v-container>
</template>
