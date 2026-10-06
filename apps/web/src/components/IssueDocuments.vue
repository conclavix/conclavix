<script setup lang="ts">
import { mdiPlus } from '@mdi/js';
import { ref, watch } from 'vue';
import { api } from '../api/client';
import type { DocumentSummary, Page } from '../api/types';
import { describeError } from '../issues';
import DocumentCreateForm from './DocumentCreateForm.vue';
import DocumentPanel from './DocumentPanel.vue';

const props = defineProps<{ issueKey: string }>();
const documents = ref<DocumentSummary[]>([]);
const selected = ref<string | null>(null);
const creating = ref(false);
const error = ref('');

async function load(): Promise<void> {
  error.value = '';
  try {
    documents.value = (
      await api<Page<DocumentSummary>>(`/issues/${props.issueKey}/documents`)
    ).items;
    if (!selected.value || !documents.value.some((doc) => doc.key === selected.value)) {
      selected.value = documents.value[0]?.key ?? null;
    }
  } catch (cause) {
    error.value = describeError(cause);
  }
}
watch(
  () => props.issueKey,
  () => {
    selected.value = null;
    creating.value = false;
    void load();
  },
  { immediate: true },
);

function created(key: string): void {
  creating.value = false;
  selected.value = key;
  void load();
}
</script>

<template>
  <v-row dense data-test="issue-documents">
    <v-col cols="12" md="3">
      <v-list density="compact" nav>
        <v-list-item
          v-for="doc in documents"
          :key="doc.key"
          :active="!creating && selected === doc.key"
          :title="doc.title"
          :subtitle="`${doc.key} · rev ${doc.revision}`"
          :data-doc="doc.key"
          @click="
            creating = false;
            selected = doc.key;
          "
        />
        <v-list-item v-if="documents.length === 0" subtitle="No documents yet" />
      </v-list>
      <v-btn block variant="tonal" :prepend-icon="mdiPlus" @click="creating = true">
        New document
      </v-btn>
    </v-col>
    <v-col cols="12" md="9">
      <v-alert v-if="error" type="error" variant="tonal" class="mb-2">{{ error }}</v-alert>
      <DocumentCreateForm
        v-if="creating"
        :issue-key="issueKey"
        :taken="documents.map((doc) => doc.key)"
        @created="created"
        @cancel="creating = false"
      />
      <DocumentPanel
        v-else-if="selected"
        :key="selected"
        :issue-key="issueKey"
        :doc-key="selected"
        @saved="load"
      />
    </v-col>
  </v-row>
</template>
