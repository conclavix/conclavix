<script setup lang="ts">
import { mdiMagnify, mdiPlus, mdiRefresh } from '@mdi/js';
import { computed, ref, watch } from 'vue';
import type { Memory, MemoryFields, MemoryScope } from '../../api/memory';
import { bucketFor } from '../../memory/logic';
import { errorText, useMemories } from '../../memory/useMemories';
import MemoryDeleteDialog from './MemoryDeleteDialog.vue';
import MemoryEditor from './MemoryEditor.vue';
import MemoryItem from './MemoryItem.vue';

/**
 * Lists, searches and edits the memories of one bucket. `scope` 'project' needs `projectId`,
 * 'agent' needs `agentId`; until then the panel asks for one instead of loading.
 */
const props = withDefaults(
  defineProps<{
    scope: MemoryScope;
    projectId?: string | null;
    agentId?: string | null;
    canCreate?: boolean;
    /** Hide every write action (New, Edit, Delete), e.g. for viewers. */
    readOnly?: boolean;
  }>(),
  { projectId: null, agentId: null, canCreate: true, readOnly: false },
);
const emit = defineEmits<{ changed: [] }>();

const bucket = computed(() => bucketFor(props.scope, props.projectId, props.agentId));
const memories = useMemories(bucket);
const { query, hits, loading, error, searched, truncated } = memories;

const editorOpen = ref(false);
const editing = ref<Memory | null>(null);
const deleting = ref<Memory | null>(null);
const expanded = ref<string[]>([]);

watch([bucket, searched], () => {
  expanded.value = [];
});

function openCreate(): void {
  editing.value = null;
  editorOpen.value = true;
}

async function openEdit(memory: Memory): Promise<void> {
  try {
    editing.value = await memories.load(memory.id);
    editorOpen.value = true;
  } catch (cause) {
    error.value = errorText(cause);
  }
}

async function save(fields: MemoryFields): Promise<void> {
  await memories.save(editing.value, fields);
  emit('changed');
}

async function remove(memory: Memory): Promise<void> {
  await memories.remove(memory);
  emit('changed');
}
</script>

<template>
  <div class="d-flex flex-column ga-3" data-test="memory-panel">
    <div class="d-flex align-center ga-2">
      <v-text-field
        :model-value="query"
        :prepend-inner-icon="mdiMagnify"
        label="Search"
        density="compact"
        hide-details
        clearable
        :disabled="!bucket"
        data-test="memory-search"
        @update:model-value="(value: string | null) => memories.search(value ?? '')"
        @keydown.enter="memories.reload"
      />
      <v-btn
        :icon="mdiRefresh"
        variant="text"
        aria-label="Reload"
        :disabled="!bucket"
        :loading="loading"
        @click="memories.reload"
      />
      <v-btn
        v-if="canCreate && !readOnly"
        color="primary"
        :prepend-icon="mdiPlus"
        :disabled="!bucket"
        data-test="memory-new"
        @click="openCreate"
      >
        New
      </v-btn>
    </div>
    <v-alert
      v-if="error"
      type="error"
      variant="tonal"
      closable
      data-test="memory-error"
      @click:close="error = ''"
    >
      {{ error }}
    </v-alert>
    <v-alert v-if="!bucket" type="info" variant="tonal">
      Pick a {{ scope }} to see its memories.
    </v-alert>
    <template v-else>
      <div v-if="searched" class="text-caption text-medium-emphasis">
        Results for "{{ searched }}", best match first. Bodies are the matching passages; open an
        entry for its full text.
      </div>
      <v-progress-linear v-if="loading && hits.length === 0" indeterminate />
      <div
        v-else-if="hits.length === 0"
        class="text-medium-emphasis pa-4 text-center"
        data-test="memory-empty"
      >
        {{ searched ? 'Nothing matches this search.' : 'No memories here yet.' }}
      </div>
      <v-expansion-panels v-else v-model="expanded" multiple variant="accordion">
        <MemoryItem
          v-for="hit in hits"
          :key="hit.memory.id"
          :hit="hit"
          :excerpt="searched !== ''"
          :load="memories.load"
          :editable="!readOnly"
          @edit="openEdit"
          @remove="(memory) => (deleting = memory)"
        />
      </v-expansion-panels>
      <div v-if="truncated" class="text-caption text-medium-emphasis">
        Showing the first {{ hits.length }} entries; search to find the others.
      </div>
    </template>
    <MemoryEditor :open="editorOpen" :memory="editing" :save="save" @close="editorOpen = false" />
    <MemoryDeleteDialog :memory="deleting" :remove="remove" @close="deleting = null" />
  </div>
</template>
