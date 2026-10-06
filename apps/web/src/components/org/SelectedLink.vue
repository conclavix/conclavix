<script setup lang="ts">
import { Panel } from '@vue-flow/core';
import { mdiDeleteOutline } from '@mdi/js';
import { computed } from 'vue';
import { PENDING_PREFIX } from '../../org/link-actions';
import { useOrgGraphStore } from '../../stores/orgGraph';

const props = defineProps<{ edgeId: string; editable: boolean }>();
const emit = defineEmits<{ remove: [id: string]; wake: [id: string, wakeOnReport: boolean] }>();
const org = useOrgGraphStore();

const link = computed(() => org.links.find((item) => item.id === props.edgeId));
/** Resolve an endpoint name, retaining a readable label when the agent is missing. */
const nameOf = (id: string): string => org.agents[id]?.name ?? 'unknown agent';
const verb = computed(() => (link.value?.type === 'reports' ? 'reports to' : 'delegates to'));
const pending = computed(() => link.value?.id.startsWith(PENDING_PREFIX) === true);
</script>

<template>
  <Panel v-if="link" position="top-center" class="selected-link d-flex align-center ga-2">
    <span class="text-body-2">
      <strong>{{ nameOf(link.from) }}</strong> {{ verb }} <strong>{{ nameOf(link.to) }}</strong>
    </span>
    <v-switch
      v-if="link.type === 'reports'"
      class="wake-switch flex-grow-0"
      color="primary"
      density="compact"
      hide-details
      inset
      label="Wake on report"
      :model-value="link.wakeOnReport === true"
      :disabled="!editable || pending"
      :title="`When work delegated to ${nameOf(link.from)} closes, ${nameOf(link.to)} is woken on its own open issue above it instead of only getting a notification.`"
      @update:model-value="(value) => emit('wake', link!.id, value === true)"
    />
    <v-btn
      v-if="editable"
      size="small"
      variant="tonal"
      color="error"
      :prepend-icon="mdiDeleteOutline"
      @click="emit('remove', link.id)"
    >
      Remove link
    </v-btn>
  </Panel>
</template>

<style scoped>
.selected-link {
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgb(var(--v-theme-surface));
  color: rgb(var(--v-theme-on-surface));
}
.wake-switch :deep(.v-label) {
  font-size: 0.875rem;
  white-space: nowrap;
}
</style>
