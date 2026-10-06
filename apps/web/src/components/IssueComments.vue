<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api } from '../api/client';
import type { Comment, Page } from '../api/types';
import { describeError } from '../issues';
import MarkdownBlock from './MarkdownBlock.vue';
import { useAuthStore } from '../stores/auth';
import { useLiveStore } from '../stores/live';

const props = defineProps<{ issueKey: string; issueId: string }>();
const live = useLiveStore();
const auth = useAuthStore();
const thread = ref<Comment[]>([]);
const draft = ref('');
const error = ref('');

watch(
  () => props.issueKey,
  async () => {
    error.value = '';
    try {
      thread.value = (
        await api<Page<Comment>>(`/issues/${props.issueKey}/comments?limit=100`)
      ).items;
    } catch (cause) {
      error.value = describeError(cause);
    }
  },
  { immediate: true },
);

const comments = computed(() => {
  const known = new Set(thread.value.map((comment) => comment.id));
  const fresh = live.state.comments.filter((c) => c.issueId === props.issueId && !known.has(c.id));
  return [...thread.value, ...fresh];
});
const authorName = (comment: Comment): string =>
  comment.author.type === 'agent'
    ? (live.state.agents[comment.author.agentId ?? '']?.name ?? 'agent')
    : comment.author.type === 'user'
      ? (auth.names[comment.author.userId ?? ''] ?? 'user')
      : comment.author.type;

async function send(): Promise<void> {
  if (!draft.value.trim()) return;
  error.value = '';
  try {
    const created = await api<Comment>(`/issues/${props.issueKey}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: draft.value }),
    });
    thread.value = [...thread.value, created];
    draft.value = '';
  } catch (cause) {
    error.value = describeError(cause);
  }
}
</script>

<template>
  <v-card>
    <v-card-title>Comments</v-card-title>
    <v-list lines="three">
      <v-list-item v-for="comment in comments" :key="comment.id" :title="authorName(comment)">
        <MarkdownBlock :source="comment.body" breaks />
      </v-list-item>
    </v-list>
    <v-card-text>
      <v-alert v-if="error" type="error" variant="tonal" class="mb-2">{{ error }}</v-alert>
      <v-textarea v-model="draft" label="Comment (wakes the assignee)" rows="2" auto-grow />
      <v-btn color="primary" :disabled="!draft.trim()" @click="send">Comment</v-btn>
    </v-card-text>
  </v-card>
</template>
