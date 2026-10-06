<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Memory, MemoryFields } from '../../api/memory';
import { fieldsProblem, LIMITS, parseTags } from '../../memory/logic';
import { errorText } from '../../memory/useMemories';
import MarkdownView from './MarkdownView.vue';

/** `memory` null with `open` true creates a new entry; a memory edits that entry. */
const props = defineProps<{
  open: boolean;
  memory: Memory | null;
  save: (fields: MemoryFields) => Promise<void>;
}>();
const emit = defineEmits<{ close: [] }>();

const title = ref('');
const body = ref('');
const tags = ref('');
const tab = ref<'write' | 'preview'>('write');
const busy = ref(false);
const error = ref('');

watch(
  () => [props.open, props.memory] as const,
  ([open, memory]) => {
    if (!open) return;
    title.value = memory?.title ?? '';
    body.value = memory?.body ?? '';
    tags.value = memory?.tags.join(', ') ?? '';
    tab.value = 'write';
    error.value = '';
  },
  { immediate: true },
);

const fields = computed<MemoryFields>(() => ({
  title: title.value,
  body: body.value,
  tags: parseTags(tags.value),
}));
const problem = computed(() => fieldsProblem(fields.value));

async function submit(): Promise<void> {
  if (problem.value) {
    error.value = problem.value;
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    await props.save(fields.value);
    emit('close');
  } catch (cause) {
    error.value = errorText(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <v-dialog
    :model-value="open"
    max-width="760"
    persistent
    scrollable
    @update:model-value="(value) => !value && emit('close')"
  >
    <v-card :title="memory ? 'Edit memory' : 'New memory'" data-test="memory-editor">
      <v-card-text>
        <v-text-field
          v-model="title"
          label="Title"
          :counter="LIMITS.title"
          autofocus
          data-test="memory-title"
        />
        <v-text-field
          v-model="tags"
          label="Tags (comma separated)"
          hint="Short keywords that help agents find this entry"
          data-test="memory-tags"
        />
        <v-tabs v-model="tab" density="compact" class="mb-2">
          <v-tab value="write">Write</v-tab>
          <v-tab value="preview">Preview</v-tab>
        </v-tabs>
        <v-textarea
          v-if="tab === 'write'"
          v-model="body"
          label="Body (Markdown)"
          rows="10"
          auto-grow
          :counter="LIMITS.body"
          data-test="memory-body"
        />
        <v-sheet v-else border rounded class="pa-3" min-height="120">
          <MarkdownView v-if="body.trim()" :source="body" />
          <span v-else class="text-medium-emphasis">Nothing to preview</span>
        </v-sheet>
        <v-alert
          v-if="error"
          type="error"
          variant="tonal"
          class="mt-3"
          data-test="memory-editor-error"
        >
          {{ error }}
        </v-alert>
      </v-card-text>
      <v-card-actions>
        <span v-if="!memory" class="text-caption text-medium-emphasis ml-2">
          Saving a title that already exists here replaces that entry.
        </span>
        <v-spacer />
        <v-btn :disabled="busy" @click="emit('close')">Cancel</v-btn>
        <v-btn
          color="primary"
          variant="flat"
          :loading="busy"
          data-test="memory-save"
          @click="submit"
        >
          Save
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
