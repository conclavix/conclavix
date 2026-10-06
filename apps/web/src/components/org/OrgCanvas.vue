<script setup lang="ts">
import '@vue-flow/core/dist/style.css';
import '@vue-flow/controls/dist/style.css';
import '@vue-flow/minimap/dist/style.css';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import {
  ConnectionMode,
  VueFlow,
  useVueFlow,
  type EdgeChange,
  type NodeChange,
  type NodeDragEvent,
} from '@vue-flow/core';
import { MiniMap } from '@vue-flow/minimap';
import { computed, watch } from 'vue';
import { useTheme } from 'vuetify';
import { toEdges, toNodes } from '../../org/nodes';
import { useLiveStore } from '../../stores/live';
import { useOrgGraphStore } from '../../stores/orgGraph';
import AgentNode from './AgentNode.vue';
import OrgLegend from './OrgLegend.vue';
import SelectedLink from './SelectedLink.vue';

const emit = defineEmits<{ open: [agentId: string] }>();

const FLOW_ID = 'org-graph';
const org = useOrgGraphStore();
const live = useLiveStore();
const theme = useTheme();
const { applyNodeChanges, applyEdgeChanges, fitView, getSelectedEdges, setNodes, setEdges } =
  useVueFlow(FLOW_ID);

const running = computed(
  () => new Set(live.activeRuns.flatMap((run) => (run.agentId ? [run.agentId] : []))),
);
const nodes = computed(() =>
  toNodes(org.agentList, {
    leadAgentId: org.leadAgentId,
    reachable: org.reachable,
    running: running.value,
    /** Supply the latest streamed status when available; node conversion handles fallback. */
    liveStatus: (id) => live.state.agents[id]?.status,
    /** Supply a streamed adapter model when the graph has no model of its own. */
    liveModel: (id) => live.state.agents[id]?.adapter?.model,
    editable: org.editable,
  }),
);
/** Resolve a theme color for edges, falling back to the inherited text color. */
const themeColor = (key: string): string => {
  const value = theme.current.value.colors[key];
  return typeof value === 'string' ? value : 'currentColor';
};
const edges = computed(() =>
  toEdges(org.links, org.editable, {
    delegates: themeColor('primary'),
    reports: themeColor('secondary'),
  }),
);
const selectedEdge = computed(() => getSelectedEdges.value[0] ?? null);

/** Apply canvas node changes while preventing the canvas from adding or deleting agents. */
function onNodesChange(changes: NodeChange[]): void {
  const kept = changes.filter((change) => change.type !== 'remove' && change.type !== 'add');
  if (kept.length > 0) applyNodeChanges(kept);
}

/** Apply edge selection locally and route removals through the persisted link action. */
function onEdgesChange(changes: EdgeChange[]): void {
  const selection = changes.filter((change) => change.type === 'select');
  if (selection.length > 0) applyEdgeChanges(selection);
  for (const change of changes) {
    if (change.type === 'remove') void org.removeLink(change.id);
  }
}

/** Round all dragged node positions and enqueue them for debounced persistence. */
function onDragStop(event: NodeDragEvent): void {
  org.moveAgents(
    Object.fromEntries(
      event.nodes.map((node) => [
        node.id,
        { x: Math.round(node.position.x), y: Math.round(node.position.y) },
      ]),
    ),
  );
}

/** Open the focused agent panel when Enter is pressed within a canvas node. */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter') return;
  const target = event.target as HTMLElement | null;
  const id = target?.closest<HTMLElement>('.vue-flow__node')?.dataset['id'];
  if (id) emit('open', id);
}

/** Fit the graph into the viewport with padding and a short animated transition. */
const fit = (): Promise<boolean> => fitView({ padding: 0.15, duration: 200 });

watch(
  [nodes, edges],
  ([nextNodes, nextEdges]) => {
    setNodes(nextNodes);
    setEdges(nextEdges);
  },
  { immediate: true },
);

let fitted = false;
/** Fit the initial graph once so later node updates do not reset the viewport. */
async function onNodesInitialized(): Promise<void> {
  if (fitted) return;
  fitted = true;
  await fit();
}

defineExpose({ fit });
</script>

<template>
  <div class="org-canvas" @keydown="onKeydown">
    <VueFlow
      :id="FLOW_ID"
      :apply-default="false"
      :connection-mode="ConnectionMode.Strict"
      :nodes-connectable="org.editable"
      :edges-updatable="false"
      :delete-key-code="['Delete', 'Backspace']"
      :min-zoom="0.2"
      :max-zoom="2"
      @nodes-initialized="onNodesInitialized"
      @nodes-change="onNodesChange"
      @edges-change="onEdgesChange"
      @connect="(connection) => void org.connect(connection)"
      @node-drag-stop="onDragStop"
      @node-click="({ node }) => emit('open', node.id)"
    >
      <template #node-agent="nodeProps">
        <AgentNode v-bind="nodeProps" />
      </template>
      <Background :gap="24" />
      <Controls :show-interactive="false" />
      <MiniMap pannable zoomable node-class-name="minimap-node" />
      <OrgLegend :editable="org.editable" />
      <SelectedLink
        v-if="selectedEdge"
        :edge-id="selectedEdge.id"
        :editable="org.editable"
        @remove="(id) => void org.removeLink(id)"
        @wake="(id, value) => void org.setWakeOnReport(id, value)"
      />
    </VueFlow>
  </div>
</template>

<style scoped>
.org-canvas {
  position: relative;
  width: 100%;
  height: 100%;
}
.org-canvas :deep(.vue-flow__background) {
  color: rgba(var(--v-theme-on-surface), 0.15);
}
.org-canvas :deep(.vue-flow__edge.edge-delegates .vue-flow__edge-path) {
  stroke: rgb(var(--v-theme-primary));
  stroke-width: 2;
}
.org-canvas :deep(.vue-flow__edge.edge-reports .vue-flow__edge-path) {
  stroke: rgb(var(--v-theme-secondary));
  stroke-width: 1.5;
  stroke-dasharray: 6 4;
}
.org-canvas :deep(.vue-flow__edge.edge-reports.edge-wakes .vue-flow__edge-path) {
  stroke-width: 2.5;
  stroke-dasharray: 2 3;
}
.org-canvas :deep(.vue-flow__edge.edge-pending .vue-flow__edge-path) {
  opacity: 0.5;
}
.org-canvas :deep(.vue-flow__edge.selected .vue-flow__edge-path) {
  stroke-width: 3.5;
}
.org-canvas :deep(.vue-flow__connection-path) {
  stroke: rgb(var(--v-theme-on-surface));
}
.org-canvas :deep(.vue-flow__minimap) {
  background: rgb(var(--v-theme-surface));
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.org-canvas :deep(.vue-flow__minimap-mask) {
  fill: rgba(var(--v-theme-on-surface), 0.08);
}
.org-canvas :deep(.minimap-node) {
  fill: rgba(var(--v-theme-primary), 0.45);
}
.org-canvas :deep(.vue-flow__controls) {
  box-shadow: none;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.org-canvas :deep(.vue-flow__controls-button) {
  background: rgb(var(--v-theme-surface));
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  fill: rgb(var(--v-theme-on-surface));
}
.org-canvas :deep(.vue-flow__controls-button:hover) {
  background: rgba(var(--v-theme-on-surface), 0.08);
}
.org-canvas :deep(.vue-flow__node:focus-visible) {
  outline: 2px solid rgb(var(--v-theme-primary));
  border-radius: 12px;
}
</style>
