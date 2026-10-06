<script setup lang="ts">
import { computed } from 'vue';
import { STATUS_COLORS } from '../format';

const props = defineProps<{ status?: string | null | undefined }>();
const color = computed(() => STATUS_COLORS[props.status ?? '']);
</script>

<template>
  <v-chip :color="color" :variant="color ? 'flat' : 'tonal'">
    <slot>{{ status }}</slot>
  </v-chip>
</template>
