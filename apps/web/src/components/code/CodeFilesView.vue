<script setup lang="ts">
import { mdiFolderZipOutline } from '@mdi/js';
import { ref } from 'vue';
import {
  archiveUrl,
  downloadUrl,
  type FileContent,
  type TreeEntry,
  type TreeListing,
} from '../../code/api';
import { downloadFile } from '../../code/download';
import { breadcrumbs } from '../../code/logic';
import { copyText } from '../../clipboard';
import { describeError } from '../../issues';
import CodeFileList from './CodeFileList.vue';
import CodeFileViewer from './CodeFileViewer.vue';
import CodeFolderTree from './CodeFolderTree.vue';

const props = defineProps<{
  projectId: string;
  projectKey: string;
  /** The branch shown; downloads use the commit of the listing so they match what is shown. */
  refName: string;
  tree: TreeListing | null;
  file: FileContent | null;
}>();
const emit = defineEmits<{ openDir: [path: string]; openFile: [path: string] }>();

const notice = ref('');
const busy = ref(false);
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

async function run(work: () => Promise<void>): Promise<void> {
  busy.value = true;
  try {
    await work();
  } catch (cause) {
    notice.value = describeError(cause);
  } finally {
    busy.value = false;
  }
}

const shaOf = () => props.file?.sha ?? props.tree?.sha ?? props.refName;

const downloadPath = (path: string) =>
  run(() => downloadFile(downloadUrl(props.projectId, shaOf(), path), nameOf(path)));

const zipFolder = (path: string) =>
  run(() =>
    downloadFile(
      archiveUrl(props.projectId, props.refName, path),
      `${props.projectKey}-${nameOf(path) || 'root'}.zip`,
    ),
  );

async function copyPath(path: string): Promise<void> {
  notice.value = (await copyText(path))
    ? `Copied ${path}`
    : 'Copy failed; select the path by hand.';
}

const openEntry = (entry: TreeEntry) =>
  entry.type === 'blob' ? emit('openFile', entry.path) : emit('openDir', entry.path);
</script>

<template>
  <v-row dense>
    <v-col cols="12" md="3" class="d-none d-md-block">
      <v-card variant="outlined" class="code-tree-card">
        <CodeFolderTree :project-id="projectId" :listing="tree" @open="emit('openDir', $event)" />
      </v-card>
    </v-col>
    <v-col cols="12" md="9">
      <v-card variant="outlined">
        <div
          class="d-flex flex-wrap align-center ga-1 px-3 py-2 text-body-2"
          data-test="breadcrumb"
        >
          <template
            v-for="(crumb, index) in breadcrumbs(file?.path ?? tree?.path ?? '')"
            :key="crumb.path"
          >
            <span v-if="index > 0" class="text-medium-emphasis">/</span>
            <span v-if="file && crumb.path === file.path" class="font-weight-medium">{{
              crumb.name
            }}</span>
            <a v-else href="#" class="text-primary" @click.prevent="emit('openDir', crumb.path)">{{
              crumb.name
            }}</a>
          </template>
          <v-spacer />
          <v-btn
            v-if="!file && tree && tree.path !== ''"
            :prepend-icon="mdiFolderZipOutline"
            size="small"
            variant="text"
            :loading="busy"
            data-test="folder-zip"
            @click="zipFolder(tree.path)"
          >
            Folder as ZIP
          </v-btn>
        </div>
        <v-divider />
        <CodeFileViewer
          v-if="file"
          :file="file"
          :project-id="projectId"
          @download="downloadPath(file.path)"
          @copy="copyPath(file.path)"
        />
        <CodeFileList
          v-else
          :tree="tree"
          @open="openEntry"
          @up="emit('openDir', $event)"
          @download="downloadPath($event.path)"
          @zip="zipFolder"
          @copy="copyPath"
        />
      </v-card>
    </v-col>
  </v-row>
  <v-snackbar
    :model-value="notice !== ''"
    timeout="3000"
    data-test="code-notice"
    @update:model-value="notice = ''"
  >
    {{ notice }}
  </v-snackbar>
</template>
