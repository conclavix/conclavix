<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { avatarColor, initials, loadAvatar } from '../api/avatars';

const props = withDefaults(
  defineProps<{
    name: string;
    src?: string | null;
    colorKey?: string | undefined;
    size?: number | string;
  }>(),
  { src: null, size: 40 },
);

const objectUrl = ref<string | null>(null);
const failed = ref(false);

watch(
  () => props.src,
  async (src) => {
    objectUrl.value = null;
    failed.value = false;
    if (!src) return;
    try {
      const url = await loadAvatar(src);
      if (props.src === src) objectUrl.value = url;
    } catch {
      if (props.src === src) failed.value = true;
    }
  },
  { immediate: true },
);

const color = computed(() => avatarColor(props.colorKey ?? props.name));
</script>

<template>
  <v-avatar
    :size="size"
    :color="objectUrl ? undefined : color"
    :title="failed ? `${name} (avatar unavailable)` : name"
    :data-avatar="objectUrl ? 'image' : 'initials'"
  >
    <v-img v-if="objectUrl" :src="objectUrl" :alt="name" cover />
    <span v-else class="text-caption font-weight-bold" aria-hidden="true">{{
      initials(name)
    }}</span>
  </v-avatar>
</template>
