<script setup lang="ts">
import { computed } from 'vue';
import { rawUrl, type FileContent } from '../../code/api';
import { highlight, splitHighlightedLines } from '../../code/highlight';
import { MAX_IMAGE_BYTES, formatBytes, isImagePath } from '../../code/logic';

const props = defineProps<{ file: FileContent; projectId: string }>();

const image = computed(() => isImagePath(props.file.path));
/** Addressed by commit id, so the browser keeps it until the file view moves to another commit. */
const imageUrl = computed(() => rawUrl(props.projectId, props.file.sha, props.file.path));

const lines = computed(() =>
  image.value || props.file.content === null
    ? []
    : splitHighlightedLines(highlight(props.file.content, props.file.path)),
);
</script>

<template>
  <div data-test="file-viewer">
    <div class="d-flex align-center ga-2 px-3 py-2 code-file-header">
      <span class="font-weight-medium text-truncate" data-test="file-path">{{ file.path }}</span>
      <v-spacer />
      <span class="text-caption text-medium-emphasis">{{ formatBytes(file.size) }}</span>
    </div>
    <template v-if="image">
      <v-alert
        v-if="file.size > MAX_IMAGE_BYTES"
        type="info"
        variant="tonal"
        density="compact"
        class="ma-3"
      >
        This image is larger than 10 MB. Download the ZIP to get it.
      </v-alert>
      <div v-else class="pa-3 code-image-box">
        <a :href="imageUrl" target="_blank" rel="noopener" title="Open full size">
          <img :src="imageUrl" :alt="file.path" class="code-image" data-test="file-image" />
        </a>
      </div>
    </template>
    <v-alert v-else-if="file.binary" type="info" variant="tonal" density="compact" class="ma-3">
      Binary file, not shown. Download the ZIP to get it.
    </v-alert>
    <v-alert v-else-if="file.tooLarge" type="info" variant="tonal" density="compact" class="ma-3">
      This file is larger than the viewer limit. Download the ZIP to get it.
    </v-alert>
    <div v-else class="code-scroll">
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
  </div>
</template>
