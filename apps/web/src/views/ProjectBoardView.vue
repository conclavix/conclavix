<script setup lang="ts">
import {
  mdiAccountMultipleOutline,
  mdiClockOutline,
  mdiFormatListChecks,
  mdiMagnify,
  mdiPencil,
  mdiPlus,
} from '@mdi/js';
import { computed, defineAsyncComponent, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { isAdminRole } from '../admin/gating';
import { canEditAgents } from '../agents/skills';
import type { IssueDetail, ProjectAgent } from '../api/types';
import IssueBoard from '../components/IssueBoard.vue';
import IssueCreateDialog from '../components/IssueCreateDialog.vue';
import ProjectDialog from '../components/ProjectDialog.vue';
import ProjectAgentsTab from '../components/projects/ProjectAgentsTab.vue';
import ProjectDescription from '../components/projects/ProjectDescription.vue';
import StatusChip from '../components/StatusChip.vue';
import { ago } from '../format';
import { BOARD_COLUMNS, describeError } from '../issues';
import { disabledAgentIds, loadProjectAgents } from '../projects/agents';
import { issueRepoContext, provideRepoContext } from '../repo-context';
import { useAuthStore } from '../stores/auth';
import { useBoardIssues } from '../stores/board';
import { useLiveStore } from '../stores/live';
import { useProjectsStore } from '../stores/projects';

const ProjectCodeTab = defineAsyncComponent(() => import('../components/code/ProjectCodeTab.vue'));
const ProjectMediaTab = defineAsyncComponent(
  () => import('../components/media/ProjectMediaTab.vue'),
);
const ProjectSecretsTab = defineAsyncComponent(
  () => import('../components/projects/ProjectSecretsTab.vue'),
);
const ConnectionsPanel = defineAsyncComponent(
  () => import('../components/connections/ConnectionsPanel.vue'),
);

const props = defineProps<{ projectKey: string }>();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const live = useLiveStore();
const projects = useProjectsStore();
const filter = ref<string | null>('');
const creating = ref(false);
const editing = ref(false);
const error = ref('');
const disabledAgents = ref<Set<string>>(new Set());
const markersError = ref('');
/** The project's agents as last loaded; null until known (or when loading failed). */
const projectAgents = ref<ProjectAgent[] | null>(null);

const TABS = ['board', 'agents', 'code', 'media', 'secrets'] as const;
/** Project secrets are for owners and admins; the API refuses everyone else as well. */
const canSeeSecrets = computed(() => isAdminRole(auth.me?.role));
const tab = computed({
  get: () => {
    const value = String(route.query['tab'] ?? 'board');
    if (value === 'secrets' && !canSeeSecrets.value) return 'board';
    return (TABS as readonly string[]).includes(value) ? value : 'board';
  },
  set: (value: string) => void router.replace({ query: { tab: value } }),
});

const project = computed(() => projects.items.find((p) => p.key === props.projectKey) ?? null);
const projectId = computed(() => project.value?.id ?? null);
provideRepoContext(() => issueRepoContext(project.value ? { projectId: project.value.id } : null));
const { issues, agentNames } = useBoardIssues(projectId, filter);
const { issues: allIssues } = useBoardIssues(projectId, ref(''));

const openIssues = computed(
  () => allIssues.value.filter((i) => i.status !== 'done' && i.status !== 'cancelled').length,
);
const activeAgents = computed(() =>
  projectAgents.value === null
    ? null
    : projectAgents.value.filter((a) => a.enabled && a.status === 'active').length,
);
const lastActivity = computed(() => {
  const stamps = allIssues.value.map((i) => i.updatedAt).filter((t): t is string => !!t);
  if (project.value?.updatedAt) stamps.push(project.value.updatedAt);
  return stamps.reduce<string | null>((latest, t) => (!latest || t > latest ? t : latest), null);
});
const filtering = computed(() => !!(filter.value ?? '').trim());
const canCreate = computed(() => project.value?.status === 'active');
const agentsReadOnly = computed(() => !canEditAgents(auth.me?.role));

function agentsChanged(agents: ProjectAgent[]): void {
  projectAgents.value = agents;
  disabledAgents.value = disabledAgentIds(agents);
}

async function load(): Promise<void> {
  error.value = '';
  markersError.value = '';
  disabledAgents.value = new Set();
  projectAgents.value = null;
  try {
    await projects.load();
    if (!project.value) {
      error.value = `Project ${props.projectKey} not found`;
      return;
    }
    const id = project.value.id;
    await Promise.all([live.loadIssues({ projectId: id }), loadAgentMarkers(id)]);
  } catch (cause) {
    error.value = describeError(cause);
  }
}

/** Board markers for assignees not enabled here; a failure leaves the board usable. */
async function loadAgentMarkers(id: string): Promise<void> {
  try {
    const agents = await loadProjectAgents(id);
    if (projectId.value === id) agentsChanged(agents);
  } catch (cause) {
    if (projectId.value === id) markersError.value = describeError(cause);
  }
}
watch(() => props.projectKey, load, { immediate: true });

const opened = (issue: IssueDetail): void =>
  void router.push({ name: 'issue', params: { issueKey: issue.key } });
</script>

<template>
  <v-container fluid class="pa-3 project-page">
    <v-alert v-if="error" type="error" variant="tonal" class="mb-2">{{ error }}</v-alert>
    <v-alert v-if="markersError" type="warning" variant="tonal" density="compact" class="mb-2">
      Could not load which agents are enabled in this project: {{ markersError }}
    </v-alert>
    <template v-if="project">
      <v-card variant="flat" rounded="lg" border class="mb-3" data-test="project-header">
        <v-card-text class="pa-4">
          <div class="d-flex align-center flex-wrap ga-3">
            <v-chip
              color="primary"
              variant="tonal"
              label
              class="font-weight-bold project-key"
              data-test="project-key"
            >
              {{ project.key }}
            </v-chip>
            <h1 class="text-h5 font-weight-medium project-name ma-0" data-test="project-title">
              {{ project.name }}
            </h1>
            <StatusChip :status="project.status" size="small" data-test="project-status" />
            <v-tooltip text="Edit project" location="bottom">
              <template #activator="{ props: tip }">
                <v-btn
                  v-bind="tip"
                  :icon="mdiPencil"
                  variant="text"
                  size="small"
                  aria-label="Edit project"
                  @click="editing = true"
                />
              </template>
            </v-tooltip>
            <v-spacer />
            <v-btn
              color="primary"
              :prepend-icon="mdiPlus"
              :disabled="!canCreate"
              data-test="new-issue"
              @click="creating = true"
            >
              New issue
            </v-btn>
          </div>
          <div
            class="d-flex flex-wrap align-center ga-4 mt-2 text-body-2 text-medium-emphasis"
            data-test="project-stats"
          >
            <span class="d-inline-flex align-center ga-1">
              <v-icon :icon="mdiFormatListChecks" size="18" />
              <strong class="text-high-emphasis">{{ openIssues }}</strong>
              open {{ openIssues === 1 ? 'issue' : 'issues' }}
            </span>
            <span class="d-inline-flex align-center ga-1">
              <v-icon :icon="mdiAccountMultipleOutline" size="18" />
              <strong class="text-high-emphasis">{{ activeAgents ?? '–' }}</strong>
              {{ activeAgents === 1 ? 'agent' : 'agents' }} active
            </span>
            <span v-if="lastActivity" class="d-inline-flex align-center ga-1">
              <v-icon :icon="mdiClockOutline" size="18" />
              last activity
              <strong class="text-high-emphasis" :title="lastActivity">
                {{ ago(lastActivity) }} ago
              </strong>
            </span>
          </div>
          <template v-if="project.description.trim()">
            <v-divider class="my-3" />
            <ProjectDescription :source="project.description" />
          </template>
        </v-card-text>
      </v-card>
      <div class="d-flex align-center flex-wrap ga-2 mb-3 project-tabs">
        <v-tabs v-model="tab" color="primary" density="compact">
          <v-tab value="board" data-test="tab-board">Board</v-tab>
          <v-tab value="agents" data-test="tab-agents">Agents</v-tab>
          <v-tab value="code" data-test="tab-code">Code</v-tab>
          <v-tab value="media" data-test="tab-media">Media</v-tab>
          <v-tab v-if="canSeeSecrets" value="secrets" data-test="tab-secrets">Secrets</v-tab>
        </v-tabs>
        <v-spacer />
        <v-text-field
          v-if="tab === 'board'"
          v-model="filter"
          placeholder="Filter by key or title"
          aria-label="Filter by key or title"
          :prepend-inner-icon="mdiMagnify"
          density="compact"
          variant="outlined"
          clearable
          hide-details
          class="project-filter"
        />
      </div>
      <ProjectAgentsTab
        v-if="tab === 'agents'"
        :project-id="project.id"
        :read-only="agentsReadOnly"
        style="max-width: 900px"
        @changed="agentsChanged"
      />
      <ProjectCodeTab
        v-else-if="tab === 'code'"
        :project-id="project.id"
        :project-key="project.key"
      />
      <ProjectMediaTab
        v-else-if="tab === 'media'"
        :key="project.id"
        :project-id="project.id"
        :project-key="project.key"
      />
      <div v-else-if="tab === 'secrets'" style="max-width: 1100px">
        <ProjectSecretsTab :project-id="project.id" :is-owner="auth.me?.role === 'owner'" />
        <h2 class="text-h6 mt-6 mb-2">Connections</h2>
        <ConnectionsPanel
          :project-id="project.id"
          :is-owner="auth.me?.role === 'owner'"
          :projects="[]"
        />
      </div>
      <IssueBoard
        v-else
        :issues="issues"
        :columns="BOARD_COLUMNS"
        :agent-names="agentNames"
        :disabled-agents="disabledAgents"
        :filtered="filtering"
        :can-create="canCreate"
        @create="creating = true"
      />
      <IssueCreateDialog v-model="creating" :project-id="project.id" @created="opened" />
      <ProjectDialog v-model="editing" :project="project" />
    </template>
  </v-container>
</template>

<style scoped>
.project-name {
  line-height: 1.2;
  overflow-wrap: anywhere;
}
.project-key {
  letter-spacing: 0.04em;
}
.project-tabs {
  border-bottom: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.project-filter {
  max-width: 320px;
  min-width: 200px;
  margin-bottom: 4px;
}
</style>
