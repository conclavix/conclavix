<script setup lang="ts">
import { mdiDeleteOutline, mdiPencilOutline, mdiTextBoxSearchOutline } from '@mdi/js';
import { computed, ref, watch } from 'vue';
import type { Memory } from '../../api/memory';
import { ago } from '../../format';
import type { MemoryHit } from '../../memory/logic';
import { errorText } from '../../memory/useMemories';
import { useAuthStore } from '../../stores/auth';
import { useLiveStore } from '../../stores/live';
import MarkdownView from './MarkdownView.vue';

/**
 * `excerpt` marks a search hit whose body is a matching passage rather than the whole entry;
 * `editable` false hides Edit and Delete for roles that may only read.
 */
const props = withDefaults(
  defineProps<{
    hit: MemoryHit;
    excerpt: boolean;
    load: (id: string) => Promise<Memory>;
    editable?: boolean;
  }>(),
  { editable: true },
);
const emit = defineEmits<{ edit: [memory: Memory]; remove: [memory: Memory] }>();

const live = useLiveStore();
const auth = useAuthStore();
const full = ref<Memory | null>(null);
const loading = ref(false);
const error = ref('');

watch(
  () => props.hit,
  () => {
    full.value = null;
    error.value = '';
  },
);

const shown = computed(() => full.value ?? (props.excerpt ? null : props.hit.memory));
const author = computed(() => {
  const value = (shown.value ?? props.hit.memory).author;
  if (value.type === 'agent') return live.state.agents[value.agentId]?.name ?? 'an agent';
  if (value.type === 'user') return auth.names[value.userId] ?? 'a user';
  return 'board';
});

async function loadFull(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    full.value = await props.load(props.hit.memory.id);
  } catch (cause) {
    error.value = errorText(cause);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <v-expansion-panel :value="hit.memory.id" :data-test="`memory-item-${hit.memory.id}`">
    <v-expansion-panel-title>
      <div class="d-flex flex-wrap align-center ga-2 w-100 pr-2">
        <span class="font-weight-medium" data-test="memory-item-title">{{ hit.memory.title }}</span>
        <v-chip v-for="tag in hit.memory.tags" :key="tag" size="x-small">{{ tag }}</v-chip>
        <v-spacer />
        <span v-if="shown" class="text-caption text-medium-emphasis">
          {{ ago(shown.updatedAt) }} ago
        </span>
        <v-chip v-else size="x-small" color="primary">
          {{ hit.excerpts.length }} match{{ hit.excerpts.length === 1 ? '' : 'es' }}
        </v-chip>
      </div>
    </v-expansion-panel-title>
    <v-expansion-panel-text>
      <template v-if="shown">
        <MarkdownView :source="shown.body" data-test="memory-item-body" />
        <div class="text-caption text-medium-emphasis mt-3">
          by {{ author }} · revision {{ shown.revision }} · updated
          {{ new Date(shown.updatedAt).toLocaleString() }}
        </div>
      </template>
      <template v-else>
        <v-sheet
          v-for="(text, index) in hit.excerpts"
          :key="index"
          border
          rounded
          class="pa-2 mb-2"
        >
          <MarkdownView :source="text" />
        </v-sheet>
        <v-btn
          size="small"
          variant="text"
          :prepend-icon="mdiTextBoxSearchOutline"
          :loading="loading"
          @click="loadFull"
        >
          Show full entry
        </v-btn>
      </template>
      <v-alert v-if="error" type="error" variant="tonal" class="mt-2">{{ error }}</v-alert>
      <div v-if="editable" class="d-flex ga-2 mt-3">
        <v-btn
          size="small"
          variant="tonal"
          :prepend-icon="mdiPencilOutline"
          data-test="memory-edit"
          @click="emit('edit', hit.memory)"
        >
          Edit
        </v-btn>
        <v-btn
          size="small"
          variant="tonal"
          color="error"
          :prepend-icon="mdiDeleteOutline"
          data-test="memory-delete"
          @click="emit('remove', hit.memory)"
        >
          Delete
        </v-btn>
      </div>
    </v-expansion-panel-text>
  </v-expansion-panel>
</template>
