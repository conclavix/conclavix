<script setup lang="ts">
import { mdiSourceCommit } from '@mdi/js';
import { computed, ref, watch } from 'vue';
import { codeApi, type CommitDetail, type CommitSummary } from '../../code/api';
import { useRequests } from '../../code/requests';
import { ago } from '../../format';
import CodeDiffView from './CodeDiffView.vue';

const props = defineProps<{ projectId: string; branch: string; selected: string | undefined }>();
const emit = defineEmits<{ select: [sha: string] }>();

const commits = ref<CommitSummary[]>([]);
const nextSkip = ref<number | null>(null);
const commit = ref<CommitDetail | null>(null);
const { loading, error, guarded, settle } = useRequests();

const loadCommits = (more = false) =>
  settle(
    'commits',
    () => codeApi.commits(props.projectId, props.branch, more ? (nextSkip.value ?? 0) : 0),
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

watch(
  () => [props.projectId, props.branch],
  () => guarded(() => loadCommits()),
  { immediate: true },
);
watch(
  () => props.selected,
  (sha) => guarded(() => loadCommit(sha)),
  { immediate: true },
);

const request = computed(() => (commit.value ? { commit: commit.value.sha } : null));
</script>

<template>
  <v-progress-linear v-if="loading" indeterminate class="mb-2" />
  <v-alert v-if="error" type="error" variant="tonal" class="mb-3">{{ error }}</v-alert>
  <v-row dense>
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
            :data-test="`commit-${item.shortSha}`"
            @click="emit('select', item.sha)"
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
        <v-card-subtitle class="text-wrap">
          {{ commit.shortSha }} · {{ commit.authorName }} &lt;{{ commit.authorEmail }}&gt; ·
          {{ ago(commit.authoredAt) }} ago
        </v-card-subtitle>
        <v-card-text>
          <pre v-if="commit.body" class="code-font mb-3" style="white-space: pre-wrap">{{
            commit.body
          }}</pre>
          <CodeDiffView
            :diff="commit.diff"
            :project-id="projectId"
            :from-sha="commit.parents[0] ?? null"
            :to-sha="commit.sha"
            :request="request"
          />
        </v-card-text>
      </v-card>
    </v-col>
  </v-row>
</template>
