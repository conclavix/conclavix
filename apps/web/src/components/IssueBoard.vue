<script setup lang="ts">
import { mdiCancel, mdiPlus, mdiTrayRemove } from '@mdi/js';
import { computed } from 'vue';
import type { Issue, Project } from '../api/types';
import { STATUS_COLORS } from '../format';
import { PRIORITY_COLORS, groupByColumn, type BoardColumn } from '../issues';

type BoardIssue = Partial<Issue> & { id: string; columnId?: string | null };

const props = defineProps<{
  issues: BoardIssue[];
  columns: readonly BoardColumn[];
  agentNames: Record<string, string>;
  projects?: Record<string, Project> | undefined;
  /** Agents not enabled in the board's project; their open issues are marked as stalled. */
  disabledAgents?: ReadonlySet<string> | undefined;
  /** A text filter is applied, so empty columns say "no match" instead of "no issues". */
  filtered?: boolean | undefined;
  /** Offer a "New issue" action in the empty To do column. */
  canCreate?: boolean | undefined;
}>();
const emit = defineEmits<{ create: [] }>();

const stalled = (issue: BoardIssue): boolean =>
  !!issue.assigneeAgentId &&
  !!props.disabledAgents?.has(issue.assigneeAgentId) &&
  issue.status !== 'done' &&
  issue.status !== 'cancelled';

const NOT_WORKED_HINT =
  'The assignee is not enabled in this project, so the issue is not worked on. Reassign it or enable the agent on the Agents tab.';

const groups = computed(() => groupByColumn(props.issues, props.columns));
const projectName = (id?: string): string => (id && props.projects?.[id]?.name) || '';
/** Theme colour of a column, so headers and badges follow the active theme template. */
const NEUTRAL_COLUMNS: Record<string, string> = {
  backlog: 'secondary',
  cancelled: 'surface-variant',
};
const columnColor = (column: BoardColumn): string =>
  STATUS_COLORS[column.status] ?? NEUTRAL_COLUMNS[column.status] ?? 'secondary';

function emptyHint(column: BoardColumn): string {
  if (props.filtered) return 'Nothing matches the filter';
  if (column.status === 'todo') return 'Create one to get work started';
  return '';
}
</script>

<template>
  <div class="issue-board" data-test="issue-board">
    <section
      v-for="column in columns"
      :key="column.id"
      class="board-column"
      :data-column="column.id"
      :style="{ '--column-color': `var(--v-theme-${columnColor(column)})` }"
    >
      <header class="board-column__header">
        <span class="board-column__dot" aria-hidden="true" />
        <span class="text-subtitle-2 font-weight-bold">{{ column.title }}</span>
        <v-spacer />
        <v-chip
          :color="columnColor(column)"
          size="small"
          variant="tonal"
          class="font-weight-bold"
          data-test="column-count"
        >
          {{ groups[column.id]?.length ?? 0 }}
        </v-chip>
      </header>
      <div class="board-column__body">
        <v-card
          v-for="issue in groups[column.id] ?? []"
          :key="issue.id"
          :to="{ name: 'issue', params: { issueKey: issue.key } }"
          density="compact"
          variant="flat"
          rounded="lg"
          border
          class="issue-card"
        >
          <v-card-text class="pa-3">
            <div class="d-flex align-center ga-1 text-caption text-medium-emphasis">
              <span class="font-weight-medium">{{ issue.key }}</span>
              <span v-if="projects && projectName(issue.projectId)">
                · {{ projectName(issue.projectId) }}
              </span>
              <v-spacer />
              <v-chip
                v-if="issue.priority && issue.priority !== 'medium'"
                :color="PRIORITY_COLORS[issue.priority]"
                size="x-small"
              >
                {{ issue.priority }}
              </v-chip>
            </div>
            <div class="issue-card__title">{{ issue.title }}</div>
            <div class="d-flex align-center flex-wrap ga-2 mt-1 text-caption text-medium-emphasis">
              {{ (issue.assigneeAgentId && agentNames[issue.assigneeAgentId]) || 'unassigned' }}
              <v-chip v-if="issue.checkoutRunId" color="primary" size="x-small">working</v-chip>
              <v-tooltip v-if="stalled(issue)" :text="NOT_WORKED_HINT">
                <template #activator="{ props: tip }">
                  <v-chip
                    v-bind="tip"
                    color="warning"
                    size="x-small"
                    :prepend-icon="mdiCancel"
                    data-test="assignee-not-enabled"
                  >
                    not enabled here
                  </v-chip>
                </template>
              </v-tooltip>
            </div>
          </v-card-text>
        </v-card>
        <div
          v-if="!(groups[column.id]?.length ?? 0)"
          class="board-column__empty text-medium-emphasis"
          data-test="column-empty"
        >
          <v-icon :icon="mdiTrayRemove" size="28" class="mb-1" />
          <div class="text-body-2">{{ filtered ? 'No matching issues' : 'No issues' }}</div>
          <div v-if="emptyHint(column)" class="text-caption">{{ emptyHint(column) }}</div>
          <v-btn
            v-if="column.status === 'todo' && canCreate && !filtered"
            variant="tonal"
            color="primary"
            size="small"
            class="mt-2"
            :prepend-icon="mdiPlus"
            data-test="column-create"
            @click="emit('create')"
          >
            New issue
          </v-btn>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.issue-board {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  padding-bottom: 8px;
  scroll-snap-type: x proximity;
}
.board-column {
  flex: 1 1 0;
  min-width: min(220px, 80vw);
  display: flex;
  flex-direction: column;
  border: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-top: 3px solid rgb(var(--column-color));
  border-radius: 12px;
  background: rgba(var(--v-theme-on-surface), 0.03);
  scroll-snap-align: start;
}
.board-column__header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px 8px;
}
.board-column__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgb(var(--column-color));
}
.board-column__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px 8px 10px;
  min-height: 180px;
  max-height: max(320px, calc(100dvh - 340px));
  overflow-y: auto;
}
.board-column__empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 16px 8px;
  border: 1px dashed rgba(var(--v-border-color), calc(var(--v-border-opacity) * 1.5));
  border-radius: 8px;
}
.issue-card {
  flex-shrink: 0;
  transition: border-color 0.15s;
}
.issue-card:hover {
  border-color: rgb(var(--column-color)) !important;
}
.issue-card__title {
  font-size: 0.875rem;
  line-height: 1.35;
  margin-top: 2px;
  overflow-wrap: anywhere;
}
</style>
