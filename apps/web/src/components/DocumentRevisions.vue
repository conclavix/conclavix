<script setup lang="ts">
import type { DocumentRevision } from '../api/types';
import { useAuthStore } from '../stores/auth';
import { useLiveStore } from '../stores/live';

defineProps<{ revisions: Omit<DocumentRevision, 'body'>[]; shown: number }>();
const emit = defineEmits<{ select: [revision: number] }>();

const live = useLiveStore();
const auth = useAuthStore();
const author = (rev: Omit<DocumentRevision, 'body'>): string =>
  rev.author.type === 'agent'
    ? (live.state.agents[rev.author.agentId ?? '']?.name ?? 'agent')
    : rev.author.type === 'user'
      ? (auth.names[rev.author.userId ?? ''] ?? 'user')
      : rev.author.type;
</script>

<template>
  <div data-test="document-revisions">
    <div class="text-subtitle-2 mb-1">Revisions</div>
    <v-list density="compact" class="border rounded">
      <v-list-item
        v-for="rev in revisions"
        :key="rev.revision"
        :active="rev.revision === shown"
        :title="`rev ${rev.revision} · ${rev.title}`"
        :subtitle="`${author(rev)} · ${new Date(rev.createdAt).toLocaleString()}`"
        :data-revision="rev.revision"
        @click="emit('select', rev.revision)"
      />
    </v-list>
  </div>
</template>
