<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useDisplay } from 'vuetify';
import type { Diff, DiffRequest } from '../../code/api';
import { diffStats, fileTitle, initiallyOpen } from '../../code/logic';
import CodeDiffFile from './CodeDiffFile.vue';

const props = withDefaults(
  defineProps<{
    diff: Diff;
    projectId?: string;
    /** The commit the diff starts at (null: the empty tree) and the one it ends at. */
    fromSha?: string | null;
    toSha?: string;
    /** How to ask for one file's whole diff; without it truncated files only say so. */
    request?: DiffRequest | null;
  }>(),
  { projectId: '', fromSha: null, toSha: '', request: null },
);

const open = ref<string[]>([]);
watch(
  () => props.diff,
  (diff) => {
    open.value = initiallyOpen(diff.files);
  },
  { immediate: true },
);

const LAYOUT_KEY = 'conclavix.diffLayout';
const readLayout = (): 'unified' | 'split' => {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'split' ? 'split' : 'unified';
  } catch {
    return 'unified';
  }
};
const { mdAndUp } = useDisplay();
const layout = ref(readLayout());
watch(layout, (value) => {
  try {
    localStorage.setItem(LAYOUT_KEY, value);
  } catch {
    // Without storage the choice lasts for this view only.
  }
});
/** Side by side only where there is room for two columns. */
const split = computed(() => mdAndUp.value && layout.value === 'split');
const stats = computed(() => diffStats(props.diff.files));

const STATUS_COLORS: Record<string, string> = {
  added: 'success',
  deleted: 'error',
  renamed: 'info',
  copied: 'info',
  modified: 'warning',
  changed: 'warning',
};
</script>

<template>
  <div data-test="diff-view">
    <div class="d-flex align-center flex-wrap ga-3 mb-2 text-body-2">
      <span>{{ stats.files }} files changed</span>
      <span class="text-success">+{{ stats.additions }}</span>
      <span class="text-error">-{{ stats.deletions }}</span>
      <v-spacer />
      <v-btn-toggle
        v-if="mdAndUp"
        v-model="layout"
        density="compact"
        variant="outlined"
        mandatory
        divided
        data-test="diff-layout"
      >
        <v-btn value="unified" size="small">Unified</v-btn>
        <v-btn value="split" size="small" data-test="diff-layout-split">Side by side</v-btn>
      </v-btn-toggle>
      <v-btn size="small" variant="text" @click="open = diff.files.map((f) => f.path)">
        Expand all
      </v-btn>
      <v-btn size="small" variant="text" @click="open = []">Collapse all</v-btn>
    </div>
    <v-alert v-if="diff.truncated" type="warning" variant="tonal" density="compact" class="mb-2">
      This diff is larger than the display limit; some files or lines are not shown.
    </v-alert>
    <p v-if="diff.files.length === 0" class="text-medium-emphasis">No changes.</p>
    <v-expansion-panels v-model="open" multiple variant="accordion">
      <v-expansion-panel
        v-for="file in diff.files"
        :key="file.path"
        :value="file.path"
        data-test="diff-file"
      >
        <v-expansion-panel-title>
          <div class="d-flex align-center ga-2 w-100 overflow-hidden">
            <v-chip size="x-small" :color="STATUS_COLORS[file.status]" label class="flex-shrink-0">
              {{ file.status }}
            </v-chip>
            <span class="text-truncate code-font">{{ fileTitle(file) }}</span>
            <v-spacer />
            <span v-if="file.binary" class="text-caption text-medium-emphasis">binary</span>
            <span v-else class="text-caption text-no-wrap">
              <span class="text-success">+{{ file.additions }}</span>
              <span class="text-error ml-1">-{{ file.deletions }}</span>
            </span>
          </div>
        </v-expansion-panel-title>
        <v-expansion-panel-text class="code-panel">
          <CodeDiffFile
            :file="file"
            :split="split"
            :project-id="projectId"
            :from-sha="fromSha"
            :to-sha="toSha"
            :request="projectId ? request : null"
          />
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>
  </div>
</template>
