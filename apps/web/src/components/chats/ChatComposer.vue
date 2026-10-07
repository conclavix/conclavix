<script setup lang="ts">
import { mdiSend } from '@mdi/js';

/** The draft; the parent clears it once the message was accepted. */
const text = defineModel<string>({ required: true });
const props = defineProps<{ disabled: boolean; sending: boolean; hint: string | null }>();
const emit = defineEmits<{ send: [content: string] }>();

function send(): void {
  const content = text.value.trim();
  if (!content || props.disabled || props.sending) return;
  emit('send', content);
}
</script>

<template>
  <div class="chat-composer d-flex align-end ga-2 pa-2" data-test="chat-composer">
    <v-textarea
      v-model="text"
      :disabled="disabled"
      :hint="hint ?? 'Ctrl+Enter sends'"
      persistent-hint
      label="Message to the lead"
      rows="2"
      max-rows="8"
      auto-grow
      density="comfortable"
      @keydown.enter.ctrl.prevent="send"
      @keydown.enter.meta.prevent="send"
    />
    <v-btn
      color="primary"
      :icon="mdiSend"
      :disabled="disabled || !text.trim()"
      :loading="sending"
      aria-label="Send"
      data-test="chat-send"
      class="mb-6"
      @click="send"
    />
  </div>
</template>
