<script setup lang="ts">
import { ref } from 'vue';
import MarkdownBlock from './MarkdownBlock.vue';

const model = defineModel<string>({ required: true });
defineProps<{ label: string; rows?: number }>();
const preview = ref(false);
</script>

<template>
  <div>
    <div class="d-flex align-center mb-1">
      <span class="text-caption text-medium-emphasis">{{ label }}</span>
      <v-spacer />
      <v-btn-toggle v-model="preview" density="compact" mandatory variant="outlined">
        <v-btn :value="false" size="small">Write</v-btn>
        <v-btn :value="true" size="small">Preview</v-btn>
      </v-btn-toggle>
    </div>
    <MarkdownBlock v-if="preview" :source="model" class="pa-3 border rounded" />
    <v-textarea v-else v-model="model" :rows="rows ?? 5" auto-grow :aria-label="label" />
  </div>
</template>
