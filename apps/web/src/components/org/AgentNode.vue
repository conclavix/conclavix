<script setup lang="ts">
import { Handle, type Connection, type NodeProps } from '@vue-flow/core';
import { mdiCrown, mdiLanConnect, mdiLinkOff } from '@mdi/js';
import { computed } from 'vue';
import { HANDLE_SPECS } from '../../org/handles';
import { HANDLES, checkConnection } from '../../org/rules';
import { useLiveStore } from '../../stores/live';
import { useOrgGraphStore } from '../../stores/orgGraph';
import type { AgentNodeData } from '../../org/nodes';
import AvatarImage from '../AvatarImage.vue';
import StatusChip from '../StatusChip.vue';

const props = defineProps<NodeProps<AgentNodeData>>();

const agent = computed(() => props.data.agent);
const live = useLiveStore();
const avatarUrl = computed(() => {
  const current = live.state.agents[agent.value.id];
  return current && current.avatarUrl !== undefined
    ? current.avatarUrl
    : (agent.value.avatarUrl ?? null);
});
const subtitle = computed(() => agent.value.title || agent.value.role);
const org = useOrgGraphStore();
/** Allow a proposed handle connection only when editing and graph rules permit it. */
const isValidConnection = (connection: Connection): boolean =>
  org.editable &&
  checkConnection({ leadAgentId: org.leadAgentId, links: org.links }, connection).ok;
/** Disable all handles in read-only mode and delegation input on the lead agent. */
const connectable = (id: string): boolean =>
  props.data.editable && !(props.data.lead && id === HANDLES.delegationIn);
</script>

<template>
  <div
    class="agent-node"
    :class="{
      'agent-node--lead': data.lead,
      'agent-node--detached': !data.connected,
      'agent-node--selected': selected,
    }"
    :aria-label="`${agent.name}${data.lead ? ', lead' : ''}, ${data.status}`"
  >
    <Handle
      v-for="handle in HANDLE_SPECS"
      :id="handle.id"
      :key="handle.id"
      :type="handle.type"
      :position="handle.position"
      :connectable="connectable(handle.id)"
      :is-valid-connection="isValidConnection"
      :class="[`handle-${handle.id}`, { 'handle--off': !connectable(handle.id) }]"
      :title="handle.label"
      :aria-label="handle.label"
    />
    <div class="d-flex align-center ga-2">
      <AvatarImage :name="agent.name" :color-key="agent.id" :src="avatarUrl" :size="36" />
      <div class="flex-grow-1 overflow-hidden">
        <div class="font-weight-medium text-truncate">{{ agent.name }}</div>
        <div class="text-caption text-medium-emphasis text-truncate">{{ subtitle }}</div>
      </div>
      <v-progress-circular
        v-if="data.running"
        indeterminate
        size="18"
        width="2"
        color="primary"
        aria-label="Run in progress"
      />
    </div>
    <div class="d-flex align-center flex-wrap ga-1 mt-2">
      <v-chip v-if="data.lead" color="primary" :prepend-icon="mdiCrown" size="x-small">Lead</v-chip>
      <StatusChip :status="data.status" size="x-small" />
      <v-chip v-if="data.model" size="x-small" :prepend-icon="mdiLanConnect" class="model-chip">
        {{ data.model }}
      </v-chip>
      <v-chip v-if="!data.connected" color="warning" size="x-small" :prepend-icon="mdiLinkOff">
        not connected
      </v-chip>
    </div>
  </div>
</template>

<style scoped>
.agent-node {
  width: 240px;
  min-height: 112px;
  box-sizing: border-box;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgb(var(--v-theme-surface));
  color: rgb(var(--v-theme-on-surface));
}
.agent-node--lead {
  border: 2px solid rgb(var(--v-theme-primary));
}
.agent-node--detached {
  border-style: dashed;
  border-color: rgb(var(--v-theme-warning));
}
.agent-node--selected {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}
.model-chip {
  max-width: 140px;
}
.agent-node :deep(.vue-flow__handle) {
  width: 12px;
  height: 12px;
  border: 2px solid rgb(var(--v-theme-surface));
}
.agent-node :deep(.handle-delegation-in),
.agent-node :deep(.handle-delegates-out) {
  background: rgb(var(--v-theme-primary));
}
.agent-node :deep(.handle-reports-in),
.agent-node :deep(.handle-reports-out) {
  background: rgb(var(--v-theme-secondary));
}
.agent-node :deep(.handle--off) {
  opacity: 0.3;
}
</style>
