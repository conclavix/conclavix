<script setup lang="ts">
import { mdiDownload } from '@mdi/js';
import { computed, ref, watch } from 'vue';
import { codeApi, downloadUrl, type DiffRequest, type FileDiff } from '../../code/api';
import { sideBySide } from '../../code/browse';
import { downloadFile } from '../../code/download';
import { parsePatch } from '../../code/logic';
import { describeError } from '../../issues';

const props = defineProps<{
  file: FileDiff;
  split: boolean;
  projectId: string;
  /** The commit the diff starts at; null for the empty tree. */
  fromSha: string | null;
  toSha: string;
  /** How to ask for this file's whole diff; null when that is not possible. */
  request: DiffRequest | null;
}>();

/** The whole diff of this file once requested. */
const full = ref<FileDiff | null>(null);
const loading = ref(false);
const error = ref('');
watch(
  () => props.file,
  () => {
    full.value = null;
    error.value = '';
  },
);

const shown = computed(() => full.value ?? props.file);
const lines = computed(() => parsePatch(shown.value.patch));
const rows = computed(() => (props.split ? sideBySide(lines.value) : []));
const sign = (kind: string) => (kind === 'add' ? '+' : kind === 'del' ? '-' : ' ');

async function loadFull(): Promise<void> {
  if (!props.request) return;
  loading.value = true;
  error.value = '';
  try {
    const result = await codeApi.diff(props.projectId, props.request, props.file.path);
    full.value = result.diff.files.find((file) => file.path === props.file.path) ?? null;
    if (!full.value) error.value = 'The full diff of this file is not available.';
  } catch (cause) {
    error.value = describeError(cause);
  } finally {
    loading.value = false;
  }
}

const versions = computed(() => {
  const list: { label: string; sha: string; path: string }[] = [];
  if (props.fromSha && props.file.status !== 'added') {
    list.push({ label: 'old', sha: props.fromSha, path: props.file.oldPath ?? props.file.path });
  }
  if (props.file.status !== 'deleted') {
    list.push({ label: 'new', sha: props.toSha, path: props.file.path });
  }
  return list;
});

function download(version: { sha: string; path: string }): void {
  const name = version.path.slice(version.path.lastIndexOf('/') + 1);
  downloadFile(downloadUrl(props.projectId, version.sha, version.path), name).catch(
    (cause: unknown) => (error.value = describeError(cause)),
  );
}
</script>

<template>
  <div>
    <div v-if="file.binary" class="pa-3 d-flex flex-wrap align-center ga-2" data-test="diff-binary">
      <span class="text-medium-emphasis">Binary file changed.</span>
      <v-btn
        v-for="version in versions"
        :key="version.label"
        :prepend-icon="mdiDownload"
        size="small"
        variant="tonal"
        :data-test="`diff-download-${version.label}`"
        @click="download(version)"
      >
        {{ version.label }} version
      </v-btn>
    </div>
    <p v-else-if="!shown.patch && !shown.truncated" class="text-medium-emphasis pa-3">
      No textual changes (mode or rename only).
    </p>
    <div v-else class="code-scroll">
      <table v-if="split" class="code-table diff-split" data-test="diff-split">
        <colgroup>
          <col class="diff-num-col" />
          <col />
          <col class="diff-num-col" />
          <col />
        </colgroup>
        <tbody>
          <tr v-for="(row, index) in rows" :key="index">
            <td v-if="row.kind !== 'pair'" colspan="4" :class="`code-line diff-${row.kind}`">
              {{ row.text }}
            </td>
            <template v-else>
              <td class="code-num" :class="row.left && `diff-${row.left.kind}`">
                {{ row.left?.oldLine ?? '' }}
              </td>
              <td
                class="code-line diff-half"
                :class="row.left ? `diff-${row.left.kind}` : 'diff-empty'"
              >
                {{ row.left?.text ?? '' }}
              </td>
              <td class="code-num" :class="row.right && `diff-${row.right.kind}`">
                {{ row.right?.newLine ?? '' }}
              </td>
              <td
                class="code-line diff-half"
                :class="row.right ? `diff-${row.right.kind}` : 'diff-empty'"
              >
                {{ row.right?.text ?? '' }}
              </td>
            </template>
          </tr>
        </tbody>
      </table>
      <table v-else class="code-table" data-test="diff-unified">
        <tbody>
          <tr v-for="(line, index) in lines" :key="index" :class="`diff-${line.kind}`">
            <td class="code-num">{{ line.oldLine ?? '' }}</td>
            <td class="code-num">{{ line.newLine ?? '' }}</td>
            <td class="code-line">
              <span class="diff-sign">{{ sign(line.kind) }}</span
              >{{ line.text }}
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="shown.truncated" class="d-flex align-center flex-wrap ga-2 pa-2">
        <span class="text-caption text-medium-emphasis">
          The rest of this file's diff is not shown.
        </span>
        <v-btn
          v-if="request && !full"
          size="small"
          variant="text"
          color="primary"
          :loading="loading"
          data-test="diff-full"
          @click="loadFull"
        >
          Show full file diff
        </v-btn>
      </div>
    </div>
    <p v-if="error" class="text-error text-caption pa-2">{{ error }}</p>
  </div>
</template>
