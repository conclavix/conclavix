<script setup lang="ts">
import { mdiChevronDown, mdiChevronRight, mdiFolderOutline, mdiSourceRepository } from '@mdi/js';
import { computed, reactive, watch } from 'vue';
import { codeApi, type TreeListing } from '../../code/api';
import { ancestorsOf, folderRows } from '../../code/browse';

const props = defineProps<{ projectId: string; listing: TreeListing | null }>();
const emit = defineEmits<{ open: [path: string] }>();

/** Subfolders of every folder loaded so far, for the commit in `loadedFor`. */
const children = reactive(new Map<string, string[]>());
const open = reactive(new Set<string>());
const loading = reactive(new Set<string>());
let loadedFor = '';

const subfolders = (listing: TreeListing) =>
  listing.entries.filter((entry) => entry.type === 'tree').map((entry) => entry.path);

/** Load the subfolders of `dir` once; a failed load shows the folder as empty. */
async function load(dir: string): Promise<void> {
  if (children.has(dir) || loading.has(dir) || !props.listing) return;
  const key = loadedFor;
  loading.add(dir);
  try {
    const listing = await codeApi.tree(props.projectId, props.listing.sha, dir);
    if (key === loadedFor) children.set(dir, subfolders(listing));
  } catch {
    if (key === loadedFor) children.set(dir, []);
  } finally {
    loading.delete(dir);
  }
}

watch(
  () => props.listing,
  (listing) => {
    if (!listing) return;
    const key = `${props.projectId}\n${listing.sha}`;
    if (key !== loadedFor) {
      loadedFor = key;
      children.clear();
      open.clear();
    }
    children.set(listing.path, subfolders(listing));
    const ancestors = ancestorsOf(listing.path);
    for (const dir of ancestors) open.add(dir);
    for (const dir of ['', ...ancestors]) void load(dir);
  },
  { immediate: true },
);

const rows = computed(() => folderRows(children, open));
const current = computed(() => props.listing?.path ?? '');

function toggle(path: string): void {
  if (open.has(path)) {
    open.delete(path);
    return;
  }
  open.add(path);
  void load(path);
}
</script>

<template>
  <v-list density="compact" nav class="code-folder-tree" data-test="folder-tree">
    <v-list-item
      :prepend-icon="mdiSourceRepository"
      title="root"
      :active="current === ''"
      @click="emit('open', '')"
    />
    <v-list-item
      v-for="row in rows"
      :key="row.path"
      :active="current === row.path"
      :style="{ paddingInlineStart: `${8 + row.depth * 14}px` }"
      :data-test="`folder-${row.path}`"
      @click="emit('open', row.path)"
    >
      <template #prepend>
        <v-btn
          :icon="row.open ? mdiChevronDown : mdiChevronRight"
          :style="{ visibility: row.expandable ? 'visible' : 'hidden' }"
          :loading="loading.has(row.path)"
          size="x-small"
          variant="text"
          density="comfortable"
          :aria-label="row.open ? `Collapse ${row.name}` : `Expand ${row.name}`"
          @click.stop="toggle(row.path)"
        />
        <v-icon :icon="mdiFolderOutline" size="small" color="primary" class="mr-1" />
      </template>
      <v-list-item-title class="code-font">{{ row.name }}</v-list-item-title>
    </v-list-item>
  </v-list>
</template>
