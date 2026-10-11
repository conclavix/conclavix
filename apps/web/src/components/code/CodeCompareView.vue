<script setup lang="ts">
import { mdiSourceCommit, mdiSwapHorizontal } from '@mdi/js';
import { computed, ref, watch } from 'vue';
import { codeApi, type BranchInfo, type DiffMode, type RefDiff } from '../../code/api';
import { DEFAULT_BRANCH } from '../../code/logic';
import { useRequests } from '../../code/requests';

import CodeDiffView from './CodeDiffView.vue';

const props = defineProps<{ projectId: string; branch: string; branches: BranchInfo[] }>();

/** The ref compared against (left side) and the one under review (right side). */
const base = ref(DEFAULT_BRANCH);
const head = ref(props.branch);
const mode = ref<DiffMode>('merge-base');
const result = ref<RefDiff | null>(null);
const { loading, error, guarded, settle } = useRequests();
const refNames = computed(() => props.branches.map((branch) => branch.name));

function compare(): Promise<void> {
  const from = base.value.trim();
  const to = head.value.trim();
  if (!from || !to) return Promise.resolve();
  return guarded(() =>
    settle(
      'diff',
      () => codeApi.diff(props.projectId, { from, to, mode: mode.value }),
      (value) => (result.value = value),
    ),
  );
}

function swap(): void {
  [base.value, head.value] = [head.value, base.value];
  void compare();
}

watch(
  () => props.branch,
  (branch) => {
    head.value = branch;
    void compare();
  },
);
watch(mode, () => void compare());
void compare();

const request = computed(() =>
  result.value
    ? { from: result.value.fromSha ?? '', to: result.value.toSha, mode: mode.value }
    : null,
);
</script>

<template>
  <div data-test="compare-view">
    <div class="d-flex flex-wrap align-center ga-2 mb-3">
      <v-combobox
        v-model="base"
        :items="refNames"
        label="Base"
        density="compact"
        hide-details
        class="code-ref-field"
        data-test="compare-base"
        @keydown.enter="compare"
      />
      <v-btn
        :icon="mdiSwapHorizontal"
        size="small"
        variant="text"
        aria-label="Swap base and compared ref"
        @click="swap"
      />
      <v-combobox
        v-model="head"
        :items="refNames"
        label="Compare"
        density="compact"
        hide-details
        class="code-ref-field"
        data-test="compare-head"
        @keydown.enter="compare"
      />
      <v-btn-toggle v-model="mode" density="compact" variant="outlined" mandatory divided>
        <v-btn value="merge-base" size="small" title="Changes since the branches split, like a PR">
          Since merge base
        </v-btn>
        <v-btn value="direct" size="small" data-test="compare-direct" title="Tree against tree">
          Direct
        </v-btn>
      </v-btn-toggle>
      <v-btn color="primary" variant="tonal" :loading="loading" @click="compare">Compare</v-btn>
    </div>
    <p class="text-caption text-medium-emphasis mb-3">
      Base and compare take a branch, a tag or a commit id.
    </p>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-3">{{ error }}</v-alert>
    <template v-if="result">
      <p class="mb-2" data-test="compare-summary">
        <strong>{{ result.to }}</strong> is {{ result.ahead }} commits ahead of and
        {{ result.behind }} commits behind <strong>{{ result.from }}</strong
        >.
        <span v-if="result.mode === 'merge-base' && !result.mergeBase" class="text-warning">
          They share no history.
        </span>
      </p>
      <v-card v-if="result.commits.length > 0" variant="outlined" class="mb-3">
        <v-list density="compact">
          <v-list-item
            v-for="item in result.commits"
            :key="item.sha"
            :title="item.subject"
            :subtitle="`${item.shortSha} · ${item.authorName}`"
            :prepend-icon="mdiSourceCommit"
          />
        </v-list>
      </v-card>
      <CodeDiffView
        :diff="result.diff"
        :project-id="projectId"
        :from-sha="result.diffBase"
        :to-sha="result.toSha"
        :request="request"
      />
    </template>
  </div>
</template>
