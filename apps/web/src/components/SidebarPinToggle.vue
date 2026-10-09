<script setup lang="ts">
import { mdiPinOffOutline, mdiPinOutline } from '@mdi/js';
import { computed } from 'vue';
import { useSidebarStore } from '../stores/sidebar';

const sidebar = useSidebarStore();
const pinned = computed(() => sidebar.mode === 'pinned');
const label = computed(() => (pinned.value ? 'Unpin sidebar' : 'Pin sidebar'));
</script>

<template>
  <v-list v-if="sidebar.wide" density="compact" nav>
    <v-list-item
      :prepend-icon="pinned ? mdiPinOffOutline : mdiPinOutline"
      :title="label"
      :aria-pressed="pinned"
      :aria-label="label"
      data-testid="sidebar-pin"
      @click="sidebar.toggle()"
    />
  </v-list>
</template>
