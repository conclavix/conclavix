<script setup lang="ts">
import { computed } from 'vue';
import type { InitItem } from '../stores/run-view';

const props = defineProps<{ item: InitItem }>();

const facts = computed(() =>
  [
    { label: 'Model', value: props.item.model },
    { label: 'Claude Code', value: props.item.claudeCodeVersion },
    { label: 'Permission mode', value: props.item.permissionMode },
    { label: 'Working directory', value: props.item.cwd },
  ].filter((fact): fact is { label: string; value: string } => Boolean(fact.value)),
);

const statusColor = (status: string): string =>
  status === 'connected' ? 'success' : status === 'pending' ? 'warning' : 'error';

const builtinTools = computed(() => props.item.tools.filter((tool) => !tool.startsWith('mcp__')));
const mcpTools = computed(() => props.item.tools.filter((tool) => tool.startsWith('mcp__')));
</script>

<template>
  <v-card variant="outlined" class="system-info">
    <v-card-title class="text-subtitle-1">Session</v-card-title>
    <v-card-text>
      <v-table v-if="facts.length" density="compact" class="mb-3">
        <tbody>
          <tr v-for="fact in facts" :key="fact.label">
            <td class="text-medium-emphasis system-info__label">{{ fact.label }}</td>
            <td class="system-info__value">{{ fact.value }}</td>
          </tr>
        </tbody>
      </v-table>
      <div class="text-overline text-medium-emphasis">MCP servers</div>
      <div class="d-flex flex-wrap ga-2 mb-3">
        <v-chip
          v-for="server in item.mcpServers"
          :key="server.name"
          :color="statusColor(server.status)"
        >
          {{ server.name }}: {{ server.status }}
        </v-chip>
        <span v-if="item.mcpServers.length === 0" class="text-medium-emphasis">none</span>
      </div>
      <template v-if="item.tools.length">
        <div class="text-overline text-medium-emphasis">
          Tools ({{ item.tools.length + item.toolsOmitted }})
        </div>
        <div class="d-flex flex-wrap ga-1 mb-2">
          <v-chip v-for="tool in mcpTools" :key="tool" color="primary" size="x-small">
            {{ tool }}
          </v-chip>
        </div>
        <div class="d-flex flex-wrap ga-1">
          <v-chip v-for="tool in builtinTools" :key="tool" size="x-small">{{ tool }}</v-chip>
          <span v-if="item.toolsOmitted" class="text-caption text-medium-emphasis">
            and {{ item.toolsOmitted }} more
          </span>
        </div>
      </template>
      <div v-else-if="item.legacy" class="text-caption text-medium-emphasis">
        This run was recorded before model and tool details were kept.
      </div>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.system-info__label {
  width: 180px;
}
.system-info__value {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.82rem;
  overflow-wrap: anywhere;
}
</style>
