<script setup lang="ts">
import {
  mdiDownload,
  mdiFileDocumentOutline,
  mdiFolderOutline,
  mdiRefresh,
  mdiSourceBranch,
  mdiSourceCommit,
} from '@mdi/js';
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { tokenStore } from '../../api/client';
import {
  archiveUrl,
  codeApi,
  type BranchComparison,
  type BranchInfo,
  type CommitDetail,
  type CommitSummary,
  type FileContent,
  type TreeEntry,
  type TreeListing,
} from '../../code/api';
import '../../code/code.css';
import {
  DEFAULT_BRANCH,
  branchLabel,
  breadcrumbs,
  formatBytes,
  emptyState,
  parentPath,
  pickBranch,
} from '../../code/logic';
import { ago } from '../../format';
import { describeError } from '../../issues';
import CodeDiffView from './CodeDiffView.vue';
import CodeFileViewer from './CodeFileViewer.vue';

const props = defineProps<{ projectId: string; projectKey: string }>();
const route = useRoute();
const router = useRouter();

const branches = ref<BranchInfo[]>([]);
const tree = ref<TreeListing | null>(null);
const file = ref<FileContent | null>(null);
const commits = ref<CommitSummary[]>([]);
const nextSkip = ref<number | null>(null);
const commit = ref<CommitDetail | null>(null);
const comparison = ref<BranchComparison | null>(null);
const view = ref<'files' | 'commits' | 'compare'>('files');
const pending = ref(0);
const loading = computed(() => pending.value > 0);
const error = ref('');
const downloading = ref(false);

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
const viewKey = computed(() =>
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

async function guarded(work: () => Promise<void>): Promise<void> {
  pending.value += 1;
  error.value = '';
  try {
    await work();
  } catch (cause) {
    error.value = describeError(cause);
  } finally {
    pending.value -= 1;
  }
}

let requestSeq = 0;
const latestRequest = new Map<string, number>();

/**
 * Run `request` for a result slot and apply its result, or rethrow its error, only while no newer
 * request claimed the same slot.
 */
async function settle<T>(
  slot: string,
  request: () => Promise<T>,
  apply: (value: T) => void,
): Promise<void> {
  const id = ++requestSeq;
  latestRequest.set(slot, id);
  const current = () => latestRequest.get(slot) === id;
  try {
    const value = await request();
    if (current()) apply(value);
  } catch (cause) {
    if (current()) throw cause;
  }
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

const loadCommits = (more = false) =>
  settle(
    'commits',
    () => codeApi.commits(props.projectId, branch.value, more ? (nextSkip.value ?? 0) : 0),
    (page) => {
      commits.value = more ? [...commits.value, ...page.items] : page.items;
      nextSkip.value = page.nextSkip;
    },
  );

const loadCommit = (sha: string | undefined) =>
  settle(
    'commit',
    () => (sha ? codeApi.commit(props.projectId, sha) : Promise.resolve(null)),
    (detail) => (commit.value = detail),
  );

const loadComparison = () =>
  settle(
    'compare',
    () =>
      branch.value === DEFAULT_BRANCH
        ? Promise.resolve(null)
        : codeApi.compare(props.projectId, branch.value),
    (result) => (comparison.value = result),
  );

/**
 * Load what the current view shows, unless it is already loaded (`force` reloads); a failed load
 * is retried the next time the view is shown.
 */
async function loadView(force = false): Promise<void> {
  const key = viewKey.value;
  if (!force && key === loadedKey) return;
  loadedKey = key;
  try {
    if (view.value === 'files') await loadFiles();
    else if (view.value === 'commits') {
      await loadCommits();
      await loadCommit(queryString('commit'));
    } else await loadComparison();
  } catch (cause) {
    if (loadedKey === key) loadedKey = '';
    throw cause;
  }
}

async function reload(force = false): Promise<void> {
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
watch(viewKey, () => guarded(() => loadView()));
watch(
  () => queryString('commit'),
  (sha) => guarded(() => loadCommit(sha)),
);

const openDir = (dirPath: string) => void replaceQuery({ path: dirPath, file: undefined });
const openEntry = (entry: TreeEntry) =>
  void (entry.type === 'blob'
    ? replaceQuery({ path: parentPath(entry.path), file: entry.path })
    : openDir(entry.path));
const openCommit = (sha: string) => void replaceQuery({ commit: sha });

/** Download through a link for session users; with a personal token the request needs a header. */
async function download(): Promise<void> {
  const url = archiveUrl(props.projectId, branch.value);
  const token = tokenStore.get();
  if (!token) {
    window.location.assign(url);
    return;
  }
  downloading.value = true;
  try {
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`download failed with ${response.status}`);
    const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(await response.blob());
    link.download = name?.[1] ?? `${props.projectKey}.zip`;
    link.click();
    URL.revokeObjectURL(link.href);
  } catch (cause) {
    error.value = describeError(cause);
  } finally {
    downloading.value = false;
  }
}
</script>

<template>
  <div data-test="code-tab">
    <div class="d-flex align-center flex-wrap ga-2 mb-3">
      <v-select
        v-model="branch"
        :items="branches"
        :item-title="branchLabel"
        item-value="name"
        label="Branch"
        density="compact"
        hide-details
        :prepend-inner-icon="mdiSourceBranch"
        style="max-width: 420px; min-width: 240px"
        data-test="branch-select"
      />
      <span v-if="selected" class="text-caption text-medium-emphasis">
        {{ selected.lastCommit.shortSha }} · {{ selected.lastCommit.subject }} ·
        {{ selected.lastCommit.authorName }}
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
    </div>
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
      <v-tab value="compare" :disabled="branch === DEFAULT_BRANCH" data-test="code-view-compare">
        Compare with main
      </v-tab>
    </v-tabs>
    <v-progress-linear v-if="loading" indeterminate class="mb-2" />

    <v-row v-if="view === 'files'" dense>
      <v-col cols="12" md="4">
        <v-card variant="outlined">
          <div class="d-flex flex-wrap align-center px-3 py-2 text-body-2">
            <template v-for="(crumb, index) in breadcrumbs(tree?.path ?? '')" :key="crumb.path">
              <span v-if="index > 0" class="mx-1 text-medium-emphasis">/</span>
              <a href="#" class="text-primary" @click.prevent="openDir(crumb.path)">{{
                crumb.name
              }}</a>
            </template>
          </div>
          <v-divider />
          <v-list density="compact" data-test="code-tree">
            <v-list-item
              v-if="tree && tree.path !== ''"
              title=".."
              :prepend-icon="mdiFolderOutline"
              @click="openDir(parentPath(tree.path))"
            />
            <v-list-item
              v-for="entry in tree?.entries ?? []"
              :key="entry.path"
              :title="entry.name"
              :subtitle="entry.type === 'blob' ? formatBytes(entry.size) : ''"
              :prepend-icon="entry.type === 'blob' ? mdiFileDocumentOutline : mdiFolderOutline"
              :active="entry.path === file?.path"
              :disabled="entry.type === 'commit'"
              @click="openEntry(entry)"
            />
            <v-list-item v-if="tree && tree.entries.length === 0" subtitle="No files" />
          </v-list>
        </v-card>
      </v-col>
      <v-col cols="12" md="8">
        <v-card variant="outlined">
          <CodeFileViewer v-if="file" :file="file" :project-id="projectId" />
          <v-card-text v-else class="text-medium-emphasis">Select a file to view it.</v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <v-row v-else-if="view === 'commits'" dense>
      <v-col cols="12" :md="commit ? 4 : 12">
        <v-card variant="outlined">
          <v-list density="compact" lines="two" data-test="commit-list">
            <v-list-item
              v-for="item in commits"
              :key="item.sha"
              :title="item.subject"
              :subtitle="`${item.shortSha} · ${item.authorName} · ${ago(item.committedAt)} ago`"
              :prepend-icon="mdiSourceCommit"
              :active="item.sha === commit?.sha"
              @click="openCommit(item.sha)"
            />
          </v-list>
          <v-card-actions v-if="nextSkip !== null">
            <v-btn variant="text" @click="guarded(() => loadCommits(true))">Load more</v-btn>
          </v-card-actions>
        </v-card>
      </v-col>
      <v-col v-if="commit" cols="12" md="8">
        <v-card variant="outlined" data-test="commit-detail">
          <v-card-title class="text-wrap">{{ commit.subject }}</v-card-title>
          <v-card-subtitle>
            {{ commit.shortSha }} · {{ commit.authorName }} &lt;{{ commit.authorEmail }}&gt; ·
            {{ ago(commit.authoredAt) }} ago
          </v-card-subtitle>
          <v-card-text>
            <pre v-if="commit.body" class="code-font mb-3" style="white-space: pre-wrap">{{
              commit.body
            }}</pre>
            <CodeDiffView :diff="commit.diff" />
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <div v-else-if="comparison" data-test="compare-view">
      <p class="mb-2">
        <strong>{{ comparison.head }}</strong> is {{ comparison.ahead }} commits ahead of and
        {{ comparison.behind }} commits behind <strong>{{ comparison.base }}</strong
        >.
      </p>
      <v-card variant="outlined" class="mb-3">
        <v-list density="compact">
          <v-list-item
            v-for="item in comparison.commits"
            :key="item.sha"
            :title="item.subject"
            :subtitle="`${item.shortSha} · ${item.authorName}`"
            :prepend-icon="mdiSourceCommit"
          />
        </v-list>
      </v-card>
      <CodeDiffView :diff="comparison.diff" />
    </div>
  </div>
</template>
