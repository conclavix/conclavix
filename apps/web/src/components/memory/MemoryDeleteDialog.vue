<script setup lang="ts">
import { ref, watch } from 'vue';
import type { Memory } from '../../api/memory';
import { errorText } from '../../memory/useMemories';

const props = defineProps<{ memory: Memory | null; remove: (memory: Memory) => Promise<void> }>();
const emit = defineEmits<{ close: [] }>();
const busy = ref(false);
const error = ref('');

watch(
  () => props.memory,
  () => {
    error.value = '';
  },
);

async function confirm(): Promise<void> {
  if (!props.memory) return;
  busy.value = true;
  try {
    await props.remove(props.memory);
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
    :model-value="memory !== null"
    max-width="460"
    :persistent="busy"
    @update:model-value="(open) => !open && emit('close')"
  >
    <v-card v-if="memory" title="Delete memory?" data-test="memory-delete-dialog">
      <v-card-text>
        <p>
          <strong>{{ memory.title }}</strong> will be removed for every agent that can read it. This
          cannot be undone.
        </p>
        <v-alert v-if="error" type="error" variant="tonal" class="mt-3">{{ error }}</v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn :disabled="busy" @click="emit('close')">Cancel</v-btn>
        <v-btn
          color="error"
          variant="flat"
          :loading="busy"
          data-test="memory-delete-confirm"
          @click="confirm"
        >
          Delete
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
