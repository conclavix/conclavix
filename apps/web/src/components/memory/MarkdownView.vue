<script setup lang="ts">
import { computed } from 'vue';
import { renderMarkdown } from '../../memory/markdown';

const props = defineProps<{ source: string }>();
const html = computed(() => renderMarkdown(props.source));
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- renderMarkdown escapes raw HTML -->
  <div class="cvx-markdown" v-html="html" />
</template>

<style scoped>
.cvx-markdown {
  overflow-wrap: anywhere;
}
.cvx-markdown :deep(> :first-child) {
  margin-top: 0;
}
.cvx-markdown :deep(> :last-child) {
  margin-bottom: 0;
}
.cvx-markdown :deep(p),
.cvx-markdown :deep(ul),
.cvx-markdown :deep(ol),
.cvx-markdown :deep(pre),
.cvx-markdown :deep(blockquote) {
  margin: 0 0 0.6em;
}
.cvx-markdown :deep(ul),
.cvx-markdown :deep(ol) {
  padding-left: 1.4em;
}
.cvx-markdown :deep(h1),
.cvx-markdown :deep(h2),
.cvx-markdown :deep(h3) {
  font-size: 1.05rem;
  margin: 0.8em 0 0.4em;
}
.cvx-markdown :deep(code) {
  font-size: 0.9em;
  padding: 0 0.25em;
  border-radius: 4px;
  background: rgba(var(--v-theme-on-surface), 0.08);
}
.cvx-markdown :deep(pre) {
  padding: 0.6em;
  overflow-x: auto;
  border-radius: 6px;
  background: rgba(var(--v-theme-on-surface), 0.06);
}
.cvx-markdown :deep(pre code) {
  padding: 0;
  background: none;
}
.cvx-markdown :deep(blockquote) {
  padding-left: 0.8em;
  border-left: 3px solid rgba(var(--v-theme-on-surface), 0.2);
}
.cvx-markdown :deep(a) {
  color: rgb(var(--v-theme-primary));
}
</style>
