<script setup lang="ts">
import {
  mdiContentCopy,
  mdiDotsVertical,
  mdiDownload,
  mdiEyeOutline,
  mdiFolderOutline,
  mdiFolderZipOutline,
} from '@mdi/js';
import type { TreeEntry, TreeListing } from '../../code/api';
import { entryIcon, entryType } from '../../code/browse';
import { formatBytes, parentPath } from '../../code/logic';

defineProps<{ tree: TreeListing | null }>();
const emit = defineEmits<{
  open: [entry: TreeEntry];
  up: [path: string];
  download: [entry: TreeEntry];
  zip: [path: string];
  copy: [path: string];
}>();
</script>

<template>
  <v-table density="compact" class="code-file-list" data-test="code-tree">
    <thead>
      <tr>
        <th>Name</th>
        <th class="text-right d-none d-sm-table-cell">Size</th>
        <th class="d-none d-md-table-cell">Type</th>
        <th class="text-right" style="width: 1%"><span class="d-sr-only">Actions</span></th>
      </tr>
    </thead>
    <tbody>
      <tr
        v-if="tree && tree.path !== ''"
        class="code-row"
        @click="emit('up', parentPath(tree.path))"
      >
        <td colspan="4"><v-icon :icon="mdiFolderOutline" size="small" class="mr-2" />..</td>
      </tr>
      <tr
        v-for="entry in tree?.entries ?? []"
        :key="entry.path"
        :class="{ 'code-row': entry.type !== 'commit' }"
        :data-test="`entry-${entry.type}`"
        @click="entry.type !== 'commit' && emit('open', entry)"
      >
        <td class="code-name-cell">
          <v-icon
            :icon="entryIcon(entry)"
            size="small"
            class="mr-2"
            :color="entry.type === 'tree' ? 'primary' : undefined"
          />
          <span class="code-font">{{ entry.name }}</span>
        </td>
        <td class="text-right text-no-wrap text-medium-emphasis d-none d-sm-table-cell">
          {{ formatBytes(entry.size) }}
        </td>
        <td class="text-medium-emphasis d-none d-md-table-cell">{{ entryType(entry) }}</td>
        <td class="text-right text-no-wrap" @click.stop>
          <v-btn
            v-if="entry.type !== 'commit'"
            :icon="entry.type === 'tree' ? mdiFolderZipOutline : mdiDownload"
            size="small"
            variant="text"
            class="d-none d-sm-inline-flex"
            :title="entry.type === 'tree' ? 'Download as ZIP' : 'Download'"
            :aria-label="`${entry.type === 'tree' ? 'Download as ZIP' : 'Download'} ${entry.name}`"
            :data-test="entry.type === 'tree' ? 'row-zip' : 'row-download'"
            @click="entry.type === 'tree' ? emit('zip', entry.path) : emit('download', entry)"
          />
          <v-menu v-if="entry.type !== 'commit'" location="bottom end">
            <template #activator="{ props: menu }">
              <v-btn
                v-bind="menu"
                :icon="mdiDotsVertical"
                size="small"
                variant="text"
                :aria-label="`Actions for ${entry.name}`"
                data-test="entry-actions"
              />
            </template>
            <v-list density="compact">
              <v-list-item
                :prepend-icon="entry.type === 'tree' ? mdiFolderOutline : mdiEyeOutline"
                :title="entry.type === 'tree' ? 'Open' : 'View'"
                @click="emit('open', entry)"
              />
              <v-list-item
                v-if="entry.type === 'blob'"
                :prepend-icon="mdiDownload"
                title="Download"
                data-test="entry-download"
                @click="emit('download', entry)"
              />
              <v-list-item
                v-if="entry.type === 'tree'"
                :prepend-icon="mdiFolderZipOutline"
                title="Download as ZIP"
                data-test="entry-zip"
                @click="emit('zip', entry.path)"
              />
              <v-list-item
                :prepend-icon="mdiContentCopy"
                title="Copy path"
                @click="emit('copy', entry.path)"
              />
            </v-list>
          </v-menu>
        </td>
      </tr>
      <tr v-if="tree && tree.entries.length === 0">
        <td colspan="4" class="text-medium-emphasis">No files</td>
      </tr>
    </tbody>
  </v-table>
</template>
