<script setup lang="ts">
import type { ActivityItem } from '../../api/overview';
import { ago } from '../../format';

defineProps<{ items: ActivityItem[]; now: number }>();

const KIND_LABELS: Record<ActivityItem['kind'], string> = {
  run_finished: 'Run',
  run_failed: 'Run',
  comment: 'Comment',
  issue_closed: 'Closed',
  issue_created: 'New issue',
};
</script>

<template>
  <v-card>
    <v-card-title>Recent activity</v-card-title>
    <v-list density="compact" lines="two" class="feed">
      <v-list-item
        v-for="(item, index) in items"
        :key="`${item.kind}-${item.at}-${index}`"
        :to="item.issueKey ? { name: 'issue', params: { issueKey: item.issueKey } } : undefined"
      >
        <v-list-item-title class="text-body-medium">{{ item.text }}</v-list-item-title>
        <v-list-item-subtitle>
          {{ KIND_LABELS[item.kind]
          }}<template v-if="item.issueKey"> &middot; {{ item.issueKey }}</template> &middot;
          {{ ago(item.at, now) }} ago
        </v-list-item-subtitle>
      </v-list-item>
      <v-list-item v-if="items.length === 0">
        <v-list-item-subtitle>No activity yet.</v-list-item-subtitle>
      </v-list-item>
    </v-list>
  </v-card>
</template>

<style scoped>
.feed {
  max-height: 480px;
  overflow-y: auto;
}
</style>
