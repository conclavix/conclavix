<script setup lang="ts">
import { computed, ref } from 'vue';
import { errorText, patchAgent } from '../../agents/api';
import type { AgentDetail } from '../../api/types';

const draft = defineModel<string>({ required: true });
const props = defineProps<{ agent: AgentDetail }>();
const emit = defineEmits<{ updated: [agent: AgentDetail] }>();

const MAX = 20000;
const saving = ref(false);
const error = ref('');
const saved = ref(false);
const dirty = computed(() => draft.value !== props.agent.instructions);

async function save(): Promise<void> {
  saving.value = true;
  error.value = '';
  try {
    emit('updated', await patchAgent(props.agent.id, { instructions: draft.value }));
    saved.value = true;
  } catch (cause) {
    error.value = errorText(cause);
  } finally {
    saving.value = false;
  }
}

function onKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key === 's') {
    event.preventDefault();
    if (dirty.value && draft.value.length <= MAX) void save();
  }
}
</script>

<template>
  <div>
    <p class="text-body-2 text-medium-emphasis mb-2">
      Markdown. The agent receives these rules at the start of every run.
    </p>
    <v-textarea
      v-model="draft"
      label="Rules"
      rows="18"
      auto-grow
      counter
      :maxlength="MAX"
      class="rules-editor"
      @keydown="onKeydown"
    />
    <v-alert v-if="error" type="error" variant="tonal" class="my-2">{{ error }}</v-alert>
    <div class="d-flex align-center ga-2">
      <v-btn color="primary" variant="flat" :disabled="!dirty" :loading="saving" @click="save">
        Save rules
      </v-btn>
      <v-btn variant="text" :disabled="!dirty" @click="draft = agent.instructions">Discard</v-btn>
      <span v-if="dirty" class="text-caption text-warning">Unsaved changes</span>
    </div>
    <v-snackbar v-model="saved" color="success" timeout="2000">Rules saved</v-snackbar>
  </div>
</template>

<style scoped>
.rules-editor :deep(textarea) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.875rem;
}
</style>
