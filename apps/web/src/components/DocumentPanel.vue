<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api/client';
import type { DocumentRevision, Page } from '../api/types';
import { conflictRevision, describeError } from '../issues';
import DocumentRevisions from './DocumentRevisions.vue';
import MarkdownField from './MarkdownField.vue';
import MarkdownBlock from './MarkdownBlock.vue';

const props = defineProps<{ issueKey: string; docKey: string }>();
const emit = defineEmits<{ saved: [] }>();

type Meta = Omit<DocumentRevision, 'body'>;
const path = `/issues/${props.issueKey}/documents/${props.docKey}`;
const latest = ref<DocumentRevision | null>(null);
const shown = ref<DocumentRevision | null>(null);
const revisions = ref<Meta[]>([]);
const raw = ref(false);
const editing = ref(false);
const draft = ref({ title: '', body: '', baseRevision: 0 });
const conflict = ref<string>('');
const error = ref('');
const saving = ref(false);

async function load(): Promise<void> {
  error.value = '';
  try {
    const [doc, history] = await Promise.all([
      api<DocumentRevision>(path),
      api<Page<Meta>>(`${path}/revisions`),
    ]);
    latest.value = doc;
    shown.value = doc;
    revisions.value = history.items;
  } catch (cause) {
    error.value = describeError(cause);
  }
}
onMounted(load);

async function showRevision(revision: number): Promise<void> {
  error.value = '';
  try {
    shown.value =
      revision === latest.value?.revision
        ? latest.value
        : await api<DocumentRevision>(`${path}/revisions/${revision}`);
  } catch (cause) {
    error.value = describeError(cause);
  }
}

function startEdit(): void {
  if (!latest.value) return;
  const { title, body, revision } = latest.value;
  draft.value = { title, body, baseRevision: revision };
  conflict.value = '';
  shown.value = latest.value;
  editing.value = true;
}

async function save(): Promise<void> {
  saving.value = true;
  error.value = '';
  conflict.value = '';
  try {
    await api<DocumentRevision>(path, { method: 'PUT', body: JSON.stringify(draft.value) });
    editing.value = false;
    await load();
    emit('saved');
  } catch (cause) {
    const current = conflictRevision(cause);
    if (current === undefined) {
      error.value = describeError(cause);
    } else {
      conflict.value =
        current === null
          ? describeError(cause)
          : `Someone else saved this document meanwhile: it is now at revision ${current}, ` +
            `your edit is based on revision ${draft.value.baseRevision}.`;
    }
  } finally {
    saving.value = false;
  }
}

async function reloadLatest(): Promise<void> {
  await load();
  startEdit();
}
</script>

<template>
  <v-card :data-test="`document-${docKey}`">
    <div class="d-flex align-center flex-wrap ga-2 px-4 pt-3">
      <span class="text-h6">{{ shown?.title ?? docKey }}</span>
      <v-chip v-if="shown">rev {{ shown.revision }}</v-chip>
      <v-chip v-if="shown && latest && shown.revision !== latest.revision" color="warning">
        old revision
      </v-chip>
      <v-spacer />
      <div v-if="!editing" class="d-flex align-center ga-2">
        <v-btn-toggle v-model="raw" density="compact" mandatory variant="outlined">
          <v-btn :value="false" size="small">Rendered</v-btn>
          <v-btn :value="true" size="small">Raw</v-btn>
        </v-btn-toggle>
        <v-btn color="primary" size="small" :disabled="!latest" @click="startEdit">Edit</v-btn>
      </div>
    </div>
    <v-card-text>
      <v-alert v-if="error" type="error" variant="tonal" class="mb-2">{{ error }}</v-alert>
      <template v-if="editing">
        <v-text-field v-model="draft.title" label="Title" />
        <MarkdownField v-model="draft.body" label="Body (Markdown)" :rows="12" />
        <v-alert
          v-if="conflict"
          type="warning"
          variant="tonal"
          class="mt-2"
          data-test="document-conflict"
        >
          {{ conflict }}
          <template #append>
            <v-btn variant="outlined" @click="reloadLatest">Reload latest (discards my edit)</v-btn>
          </template>
        </v-alert>
      </template>
      <template v-else-if="shown">
        <pre v-if="raw" class="text-body-2" style="white-space: pre-wrap">{{ shown.body }}</pre>
        <MarkdownBlock v-else :source="shown.body" />
        <DocumentRevisions
          :revisions="revisions"
          :shown="shown.revision"
          class="mt-4"
          @select="showRevision"
        />
      </template>
    </v-card-text>
    <v-card-actions v-if="editing">
      <span class="text-caption text-medium-emphasis">
        Based on revision {{ draft.baseRevision }}
      </span>
      <v-spacer />
      <v-btn @click="editing = false">Cancel</v-btn>
      <v-btn color="primary" :loading="saving" @click="save">Save</v-btn>
    </v-card-actions>
  </v-card>
</template>
