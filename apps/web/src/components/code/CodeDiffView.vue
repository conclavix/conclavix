<script setup lang="ts">
import { ref, watch } from 'vue';
import type { Diff } from '../../code/api';
import { diffStats, fileTitle, initiallyOpen, parsePatch } from '../../code/logic';

const props = defineProps<{ diff: Diff }>();
const open = ref<string[]>([]);
watch(
  () => props.diff,
  (diff) => {
    open.value = initiallyOpen(diff.files);
  },
  { immediate: true },
);

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
    <div class="d-flex align-center ga-3 mb-2 text-body-2">
      <span>{{ diffStats(diff.files).files }} files changed</span>
      <span class="text-success">+{{ diffStats(diff.files).additions }}</span>
      <span class="text-error">-{{ diffStats(diff.files).deletions }}</span>
      <v-spacer />
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
            <v-chip size="x-small" :color="STATUS_COLORS[file.status]" label>
              {{ file.status }}
            </v-chip>
            <span class="text-truncate code-font">{{ fileTitle(file) }}</span>
            <v-spacer />
            <span v-if="!file.binary" class="text-caption">
              <span class="text-success">+{{ file.additions }}</span>
              <span class="text-error ml-1">-{{ file.deletions }}</span>
            </span>
          </div>
        </v-expansion-panel-title>
        <v-expansion-panel-text class="code-panel">
          <p v-if="file.binary" class="text-medium-emphasis pa-3">Binary file changed.</p>
          <p v-else-if="!file.patch && !file.truncated" class="text-medium-emphasis pa-3">
            No textual changes (mode or rename only).
          </p>
          <div v-else class="code-scroll">
            <table class="code-table">
              <tbody>
                <tr
                  v-for="(line, index) in parsePatch(file.patch)"
                  :key="index"
                  :class="`diff-${line.kind}`"
                >
                  <td class="code-num">{{ line.oldLine ?? '' }}</td>
                  <td class="code-num">{{ line.newLine ?? '' }}</td>
                  <td class="code-line">
                    <span class="diff-sign">{{
                      line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '
                    }}</span
                    >{{ line.text }}
                  </td>
                </tr>
              </tbody>
            </table>
            <p v-if="file.truncated" class="text-caption text-medium-emphasis pa-2">
              The rest of this file's diff is not shown.
            </p>
          </div>
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>
  </div>
</template>
