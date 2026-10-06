<script setup lang="ts">
import {
  mdiAlertCircleOutline,
  mdiCheckCircleOutline,
  mdiProgressClock,
  mdiWrenchOutline,
} from '@mdi/js';
import { computed, ref } from 'vue';
import { inputSummary, toolLabel, type ToolItem } from '../stores/run-view';

const props = defineProps<{ item: ToolItem; live: boolean }>();
const open = ref(false);

const label = computed(() => toolLabel(props.item.name));
const summary = computed(() => inputSummary(props.item.input));
const state = computed(() => {
  if (props.item.result?.isError) {
    return { icon: mdiAlertCircleOutline, color: 'error', text: 'error' };
  }
  if (props.item.result) {
    return { icon: mdiCheckCircleOutline, color: 'success', text: 'done' };
  }
  return props.live
    ? { icon: mdiProgressClock, color: 'info', text: 'running' }
    : { icon: mdiWrenchOutline, color: undefined, text: 'no result' };
});
</script>

<template>
  <v-card
    variant="outlined"
    density="compact"
    class="tool-card"
    :class="{ 'tool-card--error': item.result?.isError }"
  >
    <button type="button" class="tool-card__head" :aria-expanded="open" @click="open = !open">
      <v-icon :icon="state.icon" :color="state.color" size="18" :title="state.text" />
      <span class="font-weight-medium">{{ label.tool }}</span>
      <span v-if="label.server" class="text-caption text-medium-emphasis">{{ label.server }}</span>
      <span class="tool-card__summary text-medium-emphasis">{{ summary }}</span>
    </button>
    <v-expand-transition>
      <div v-if="open" class="tool-card__body">
        <div class="text-overline text-medium-emphasis">Input</div>
        <pre class="tool-card__pre">{{ item.input || '{}' }}</pre>
        <template v-if="item.result">
          <div
            class="text-overline"
            :class="item.result.isError ? 'text-error' : 'text-medium-emphasis'"
          >
            {{ item.result.isError ? 'Error' : 'Result' }}
          </div>
          <pre class="tool-card__pre">{{ item.result.content || '(empty)' }}</pre>
        </template>
      </div>
    </v-expand-transition>
    <div
      v-if="!open && item.result"
      class="tool-card__preview text-caption"
      :class="item.result.isError ? 'text-error' : 'text-medium-emphasis'"
    >
      {{ item.result.content.slice(0, 200) || '(empty)' }}
    </div>
  </v-card>
</template>

<style scoped>
.tool-card {
  border-color: rgba(var(--v-border-color), var(--v-border-opacity));
}
.tool-card--error {
  border-color: rgb(var(--v-theme-error));
}
.tool-card__head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  text-align: left;
  color: inherit;
  font: inherit;
  background: none;
  border: 0;
  cursor: pointer;
}
.tool-card__summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8rem;
}
.tool-card__body {
  padding: 0 10px 8px;
}
.tool-card__preview {
  padding: 0 10px 6px 36px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.tool-card__pre {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 320px;
  overflow-y: auto;
  padding: 6px 8px;
  border-radius: 4px;
  background: rgba(var(--v-theme-on-surface), 0.05);
}
</style>
