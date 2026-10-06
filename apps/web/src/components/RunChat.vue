<script setup lang="ts">
import { mdiCogOutline, mdiRobotOutline, mdiThoughtBubbleOutline } from '@mdi/js';
import type { InitItem, RunItem } from '../stores/run-view';
import MarkdownBlock from './MarkdownBlock.vue';
import RunResultCard from './RunResultCard.vue';
import RunSystemInfo from './RunSystemInfo.vue';
import ToolCallCard from './ToolCallCard.vue';

defineProps<{ items: RunItem[]; live: boolean; detailedSystem?: boolean }>();

const time = (iso: string): string =>
  iso
    ? new Date(iso).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '';

const initSummary = (item: InitItem): string => {
  const servers = item.mcpServers.map((server) => `${server.name} ${server.status}`).join(', ');
  return [
    'Session started',
    item.model,
    item.tools.length ? `${item.tools.length + item.toolsOmitted} tools` : null,
    `MCP: ${servers || 'none'}`,
  ]
    .filter(Boolean)
    .join(' · ');
};
</script>

<template>
  <div class="run-chat">
    <template v-for="item in items" :key="item.key">
      <div v-if="item.kind === 'message'" class="run-chat__row">
        <v-avatar size="28" color="primary" variant="tonal" class="run-chat__avatar">
          <v-icon :icon="mdiRobotOutline" size="18" />
        </v-avatar>
        <v-sheet rounded="lg" class="run-chat__bubble" color="surface-light">
          <MarkdownBlock :source="item.markdown" />
          <div class="run-chat__time text-caption text-medium-emphasis">{{ time(item.at) }}</div>
        </v-sheet>
      </div>

      <div v-else-if="item.kind === 'thinking'" class="run-chat__indent">
        <v-expansion-panels variant="accordion" flat>
          <v-expansion-panel class="run-chat__thinking">
            <v-expansion-panel-title class="py-1 text-medium-emphasis" min-height="32">
              <v-icon :icon="mdiThoughtBubbleOutline" size="16" class="mr-2" />
              Thinking
            </v-expansion-panel-title>
            <v-expansion-panel-text class="text-medium-emphasis">
              <MarkdownBlock :source="item.text" />
            </v-expansion-panel-text>
          </v-expansion-panel>
        </v-expansion-panels>
      </div>

      <div v-else-if="item.kind === 'tool'" class="run-chat__indent">
        <ToolCallCard :item="item" :live="live" />
      </div>

      <div v-else-if="item.kind === 'result'" class="run-chat__indent">
        <RunResultCard :item="item" />
      </div>

      <template v-else-if="item.kind === 'init'">
        <RunSystemInfo v-if="detailedSystem" :item="item" />
        <div v-else class="run-chat__note text-caption text-medium-emphasis">
          <v-icon :icon="mdiCogOutline" size="14" class="mr-1" />{{ initSummary(item) }}
        </div>
      </template>

      <div v-else-if="item.type === 'stderr'" class="run-chat__mono text-error">
        <span class="run-chat__tag">stderr</span>{{ item.text }}
      </div>

      <div
        v-else-if="detailedSystem || item.type !== 'system'"
        class="run-chat__note text-caption text-medium-emphasis"
      >
        <span class="run-chat__tag">{{ item.type }}</span
        >{{ item.text }}
        <span class="ml-2">{{ time(item.at) }}</span>
      </div>
    </template>
    <div v-if="items.length === 0" class="text-medium-emphasis pa-4 text-center">
      Nothing here yet.
    </div>
  </div>
</template>

<style scoped>
.run-chat {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 16px;
}
.run-chat__row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.run-chat__avatar {
  flex: 0 0 auto;
  margin-top: 2px;
}
.run-chat__bubble {
  max-width: min(760px, 100%);
  min-width: 0;
  padding: 8px 12px;
  border-top-left-radius: 4px !important;
}
.run-chat__time {
  text-align: right;
  margin-top: 2px;
}
.run-chat__indent {
  padding-left: 36px;
  max-width: calc(760px + 36px);
}
.run-chat__thinking {
  background: rgba(var(--v-theme-on-surface), 0.03);
}
.run-chat__note {
  text-align: center;
  overflow-wrap: anywhere;
}
.run-chat__mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.run-chat__tag {
  display: inline-block;
  margin-right: 8px;
  opacity: 0.7;
  text-transform: uppercase;
  font-size: 0.7rem;
  letter-spacing: 0.04em;
}
</style>
