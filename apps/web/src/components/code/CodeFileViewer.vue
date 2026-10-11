<script setup lang="ts">
import { mdiContentCopy, mdiDownload } from '@mdi/js';
import { computed, ref } from 'vue';
import { rawUrl, type FileContent } from '../../code/api';
import { previewOf } from '../../code/browse';
import { highlight, splitHighlightedLines } from '../../code/highlight';
import { formatBytes } from '../../code/logic';
import { provideRepoContext } from '../../repo-context';
import MarkdownBlock from '../MarkdownBlock.vue';

const props = defineProps<{ file: FileContent; projectId: string }>();
const emit = defineEmits<{ download: []; copy: [] }>();

const preview = computed(() => previewOf(props.file));
/** Addressed by commit id, so the browser keeps it until the file view moves to another commit. */
const mediaUrl = computed(() => rawUrl(props.projectId, props.file.sha, props.file.path));
/** Markdown is rendered by default; the source view shows it with line numbers. */
const showSource = ref(false);
provideRepoContext(() => ({ projectId: props.projectId, ref: props.file.sha }));

const lines = computed(() =>
  props.file.content === null
    ? []
    : splitHighlightedLines(highlight(props.file.content, props.file.path)),
);

const NO_PREVIEW: Record<string, string> = {
  pdf: 'PDFs are not shown in the browser; download the file to open it.',
  binary: 'Binary file, no preview.',
  tooLarge: 'This file is larger than the viewer limit.',
  mediaTooLarge: 'This file is larger than 10 MB, so it is not previewed.',
};
</script>

<template>
  <div data-test="file-viewer">
    <div class="d-flex align-center flex-wrap ga-2 px-3 py-2 code-file-header">
      <span class="font-weight-medium text-truncate code-font" data-test="file-path">{{
        file.path
      }}</span>
      <v-spacer />
      <span class="text-caption text-medium-emphasis">{{ formatBytes(file.size) }}</span>
      <v-btn-toggle
        v-if="preview === 'markdown'"
        v-model="showSource"
        density="compact"
        variant="outlined"
        mandatory
        divided
      >
        <v-btn :value="false" size="small">Preview</v-btn>
        <v-btn :value="true" size="small" data-test="markdown-source">Source</v-btn>
      </v-btn-toggle>
      <v-btn
        :icon="mdiContentCopy"
        size="small"
        variant="text"
        aria-label="Copy path"
        title="Copy path"
        @click="emit('copy')"
      />
      <v-btn
        :prepend-icon="mdiDownload"
        size="small"
        variant="tonal"
        data-test="file-download"
        @click="emit('download')"
      >
        Download
      </v-btn>
    </div>
    <div v-if="preview === 'image'" class="pa-3 code-image-box">
      <a :href="mediaUrl" target="_blank" rel="noopener" title="Open full size">
        <img :src="mediaUrl" :alt="file.path" class="code-image" data-test="file-image" />
      </a>
    </div>
    <div v-else-if="preview === 'video'" class="pa-3 code-image-box">
      <video
        :key="mediaUrl"
        :src="mediaUrl"
        controls
        preload="metadata"
        class="code-video"
        data-test="file-video"
      />
    </div>
    <div v-else-if="preview === 'markdown' && !showSource" class="pa-4" data-test="file-markdown">
      <MarkdownBlock :source="file.content ?? ''" />
    </div>
    <div v-else-if="preview === 'markdown' || preview === 'text'" class="code-scroll">
      <table class="code-table">
        <tbody>
          <tr v-for="(line, index) in lines" :key="index">
            <td class="code-num">{{ index + 1 }}</td>
            <!-- eslint-disable-next-line vue/no-v-html -->
            <td class="code-line" v-html="line || '&#8203;'" />
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else class="pa-6 text-center" data-test="file-no-preview">
      <p class="text-medium-emphasis mb-3">{{ NO_PREVIEW[preview] }}</p>
      <v-btn color="primary" variant="tonal" :prepend-icon="mdiDownload" @click="emit('download')">
        Download {{ formatBytes(file.size) }}
      </v-btn>
    </div>
  </div>
</template>
