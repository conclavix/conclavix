<script setup lang="ts">
import { mdiDownload, mdiRefresh, mdiSourceBranch } from '@mdi/js';
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  archiveUrl,
  codeApi,
  type BranchInfo,
  type FileContent,
  type TreeListing,
} from '../../code/api';
import '../../code/code.css';
import { downloadFile } from '../../code/download';
import { branchLabel, emptyState, parentPath, pickBranch } from '../../code/logic';
import { useRequests } from '../../code/requests';
import { ago } from '../../format';
import { describeError } from '../../issues';
import CodeCommitsView from './CodeCommitsView.vue';
import CodeCompareView from './CodeCompareView.vue';
import CodeFilesView from './CodeFilesView.vue';

const props = defineProps<{ projectId: string; projectKey: string }>();
const route = useRoute();
const router = useRouter();

const branches = ref<BranchInfo[]>([]);
const tree = ref<TreeListing | null>(null);
const file = ref<FileContent | null>(null);
const view = ref<'files' | 'commits' | 'compare'>('files');
const downloading = ref(false);
/** Bumped by the reload button, so the commit and compare views load again too. */
const generation = ref(0);
const { loading, error, guarded, settle } = useRequests();

const queryString = (name: string): string | undefined => {
  const value = route.query[name];
  return typeof value === 'string' ? value : undefined;
};

const branch = computed({
  get: () => pickBranch(branches.value, queryString('branch')),
  set: (value: string) =>
    void replaceQuery({ branch: value, path: undefined, file: undefined, commit: undefined }),
});
const path = computed(() => queryString('path') ?? '');
const filePath = computed(() => queryString('file') ?? '');
const filesKey = computed(() =>
  [props.projectId, view.value, branch.value, path.value, filePath.value].join('\n'),
);
let loadedKey = '';
const selected = computed(() => branches.value.find((b) => b.name === branch.value) ?? null);
const empty = computed(() =>
  view.value === 'files'
    ? emptyState(branches.value, path.value, tree.value?.entries.length ?? null)
    : null,
);

function replaceQuery(changes: Record<string, string | undefined>) {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...route.query, ...changes })) {
    if (typeof value === 'string' && value !== '') next[key] = value;
  }
  return router.replace({ query: next });
}

const loadBranches = () =>
  settle(
    'branches',
    () => codeApi.branches(props.projectId),
    ({ items }) => (branches.value = items),
  );

/** Load the directory at `path` and, when one is selected, the file at `file`. */
const loadFiles = () => {
  const ref = branch.value;
  return settle(
    'files',
    () =>
      Promise.all([
        codeApi.tree(props.projectId, ref, path.value),
        filePath.value ? codeApi.file(props.projectId, ref, filePath.value) : Promise.resolve(null),
      ]),
    ([dir, content]) => {
      tree.value = dir;
      file.value = content;
    },
  );
};

/**
 * Load the files view unless it is already loaded (`force` reloads); a failed load is retried
 * the next time the view is shown. The other views load themselves.
 */
async function loadView(force = false): Promise<void> {
  const key = filesKey.value;
  if (view.value !== 'files' || (!force && key === loadedKey)) return;
  loadedKey = key;
  try {
    await loadFiles();
  } catch (cause) {
    if (loadedKey === key) loadedKey = '';
    throw cause;
  }
}

async function reload(force = false): Promise<void> {
  if (force) generation.value += 1;
  await guarded(async () => {
    await loadBranches();
    await loadView(force);
  });
}

watch(
  () => props.projectId,
  () => reload(),
  { immediate: true },
);
watch(filesKey, () => guarded(() => loadView()));

const openDir = (dirPath: string) => void replaceQuery({ path: dirPath, file: undefined });
const openFile = (target: string) => void replaceQuery({ path: parentPath(target), file: target });
const openCommit = (sha: string) => void replaceQuery({ commit: sha });

async function download(): Promise<void> {
  downloading.value = true;
  try {
    await downloadFile(archiveUrl(props.projectId, branch.value), `${props.projectKey}.zip`);
  } catch (cause) {
    error.value = describeError(cause);
  } finally {
    downloading.value = false;
  }
}
</script>

<template>
  <div data-test="code-tab">
    <v-sheet border rounded class="d-flex align-center flex-wrap ga-2 pa-2 mb-3 code-repo-strip">
      <v-select
        v-model="branch"
        :items="branches"
        :item-title="branchLabel"
        item-value="name"
        label="Branch"
        density="compact"
        hide-details
        :prepend-inner-icon="mdiSourceBranch"
        class="code-branch-select"
        data-test="branch-select"
      />
      <span
        v-if="selected"
        class="text-caption text-medium-emphasis text-truncate code-last-commit"
        data-test="branch-last-commit"
      >
        <span class="code-font">{{ selected.lastCommit.shortSha }}</span>
        · {{ selected.lastCommit.subject }} · {{ selected.lastCommit.authorName }} ·
        {{ ago(selected.lastCommit.committedAt) }} ago
      </span>
      <v-spacer />
      <v-btn
        :icon="mdiRefresh"
        variant="text"
        size="small"
        aria-label="Reload"
        @click="reload(true)"
      />
      <v-btn
        color="primary"
        variant="tonal"
        :prepend-icon="mdiDownload"
        :loading="downloading"
        data-test="download-zip"
        @click="download"
      >
        Download ZIP
      </v-btn>
    </v-sheet>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-3">{{ error }}</v-alert>
    <v-alert
      v-if="empty && !loading"
      type="info"
      variant="tonal"
      class="mb-3"
      data-test="code-empty"
    >
      <template v-if="empty === 'repository'">
        This repository is still empty. Agents will write their code here: each issue gets its own
        branch <code>cvx/&lt;issue key&gt;</code>, and what they commit shows up in this tab.
      </template>
      <template v-else>
        <strong>{{ branch }}</strong> has no files yet. Agents work on the issue branches
        <code>cvx/&lt;issue key&gt;</code>; pick one above to see their work.
      </template>
    </v-alert>
    <v-tabs v-model="view" density="compact" class="mb-3">
      <v-tab value="files" data-test="code-view-files">Files</v-tab>
      <v-tab value="commits" data-test="code-view-commits">Commits</v-tab>
      <v-tab value="compare" data-test="code-view-compare">Compare</v-tab>
    </v-tabs>
    <v-progress-linear v-if="loading" indeterminate class="mb-2" />

    <CodeFilesView
      v-if="view === 'files'"
      :project-id="projectId"
      :project-key="projectKey"
      :ref-name="branch"
      :tree="tree"
      :file="file"
      @open-dir="openDir"
      @open-file="openFile"
    />
    <CodeCommitsView
      v-else-if="view === 'commits'"
      :key="`commits-${projectId}-${generation}`"
      :project-id="projectId"
      :branch="branch"
      :selected="queryString('commit')"
      @select="openCommit"
    />
    <CodeCompareView
      v-else
      :key="`compare-${projectId}-${generation}`"
      :project-id="projectId"
      :branch="branch"
      :branches="branches"
    />
  </div>
</template>
