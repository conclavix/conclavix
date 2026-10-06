<script setup lang="ts">
import { mdiCheck, mdiContentCopy } from '@mdi/js';
import { ref } from 'vue';
import { copyText } from '../../clipboard';

const props = defineProps<{ value: string; label: string }>();

const state = ref<'idle' | 'copied' | 'failed'>('idle');

async function copy(): Promise<void> {
  state.value = (await copyText(props.value)) ? 'copied' : 'failed';
}
</script>

<template>
  <div>
    <div class="d-flex align-start ga-2">
      <v-sheet
        class="secret flex-grow-1 pa-3 text-body-2"
        color="surface-variant"
        rounded
        :aria-label="label"
        data-testid="secret-value"
        >{{ value }}</v-sheet
      >
      <v-btn
        :icon="state === 'copied' ? mdiCheck : mdiContentCopy"
        :color="state === 'copied' ? 'success' : undefined"
        variant="text"
        :aria-label="`Copy ${label}`"
        @click="copy"
      />
    </div>
    <div v-if="state === 'failed'" class="text-caption text-error mt-1">
      Copying is not available here; select the text and copy it by hand.
    </div>
  </div>
</template>

<style scoped>
.secret {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre-wrap;
  word-break: break-all;
  user-select: all;
}
</style>
