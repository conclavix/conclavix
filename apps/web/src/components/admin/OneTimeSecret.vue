<script setup lang="ts">
import { mdiCheck, mdiContentCopy } from '@mdi/js';
import { ref } from 'vue';

/** A temporary password shown once, with a copy button; it is never stored client-side. */
const props = defineProps<{ secret: string; label?: string }>();
const copied = ref(false);
const failed = ref(false);

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.secret);
    copied.value = true;
    failed.value = false;
  } catch {
    failed.value = true;
  }
}
</script>

<template>
  <v-text-field
    :model-value="secret"
    :label="label ?? 'Temporary password'"
    readonly
    class="one-time-secret"
    :hint="failed ? 'Copy failed; select the text and copy it by hand.' : 'Shown only now.'"
    persistent-hint
    @focus="($event.target as HTMLInputElement | null)?.select()"
  >
    <template #append-inner>
      <v-btn
        :icon="copied ? mdiCheck : mdiContentCopy"
        variant="text"
        size="small"
        :aria-label="copied ? 'Copied' : 'Copy password'"
        @click="copy"
      />
    </template>
  </v-text-field>
</template>

<style scoped>
.one-time-secret :deep(input) {
  font-family: ui-monospace, monospace;
}
</style>
