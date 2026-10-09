<script setup lang="ts">
import { mdiGavel } from '@mdi/js';
import { computed, onMounted } from 'vue';
import { useDecisionsStore } from '../stores/decisions';

const decisions = useDecisionsStore();
onMounted(() => decisions.start());

const count = computed(() => decisions.openCount);
const label = computed(() =>
  count.value === 1 ? '1 open board decision' : `${count.value} open board decisions`,
);
</script>

<template>
  <v-list-item title="Decisions" :to="{ name: 'decisions' }" data-test="nav-decisions">
    <template #prepend>
      <v-badge
        :model-value="count > 0"
        :content="count > 99 ? '99+' : count"
        :label="label"
        color="error"
        data-test="decisions-badge"
      >
        <v-icon :icon="mdiGavel" />
      </v-badge>
    </template>
  </v-list-item>
</template>
