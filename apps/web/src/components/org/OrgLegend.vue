<script setup lang="ts">
import { Panel } from '@vue-flow/core';

defineProps<{ editable: boolean }>();
</script>

<template>
  <Panel position="top-left" class="org-legend text-caption">
    <div class="d-flex align-center ga-2">
      <svg width="36" height="10" aria-hidden="true">
        <line x1="0" y1="5" x2="36" y2="5" class="legend-delegates" />
      </svg>
      delegates to
    </div>
    <div class="d-flex align-center ga-2">
      <svg width="36" height="10" aria-hidden="true">
        <line x1="0" y1="5" x2="36" y2="5" class="legend-reports" />
      </svg>
      reports to
    </div>
    <div class="d-flex align-center ga-2">
      <svg width="36" height="10" aria-hidden="true">
        <line x1="0" y1="5" x2="36" y2="5" class="legend-wakes" />
      </svg>
      reports to, wakes target
    </div>
    <div v-if="editable" class="text-medium-emphasis mt-1">
      Drag right handle to left handle to delegate,<br />
      bottom handle to top handle to report.
    </div>
  </Panel>
</template>

<style scoped>
.org-legend {
  font-size: 0.75rem;
  line-height: 1.4;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgb(var(--v-theme-surface));
  color: rgb(var(--v-theme-on-surface));
}
.legend-delegates {
  stroke: rgb(var(--v-theme-primary));
  stroke-width: 2;
}
.legend-wakes {
  stroke: rgb(var(--v-theme-secondary));
  stroke-width: 2.5;
  stroke-dasharray: 2 3;
}
.legend-reports {
  stroke: rgb(var(--v-theme-secondary));
  stroke-width: 1.5;
  stroke-dasharray: 6 4;
}
</style>
