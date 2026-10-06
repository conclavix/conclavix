<script setup lang="ts">
import { computed, ref } from 'vue';
import { renderRichMarkdown } from '../markdown-rich';
import { useRepoContext } from '../repo-context';

const props = defineProps<{ source: string; breaks?: boolean }>();
const repo = useRepoContext();
const html = computed(() =>
  renderRichMarkdown(props.source, { repo: repo.value, breaks: props.breaks }),
);

/** The image shown enlarged; images inside a link keep following the link. */
const zoomed = ref<{ src: string; alt: string } | null>(null);
function zoom(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof HTMLImageElement) || target.closest('a')) return;
  zoomed.value = { src: target.src, alt: target.alt };
}
</script>

<template>
  <div>
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div class="markdown" @click="zoom" v-html="html" />
    <v-dialog
      :model-value="zoomed !== null"
      max-width="min(1600px, 95vw)"
      @update:model-value="zoomed = null"
    >
      <v-card v-if="zoomed" data-test="image-zoom">
        <img :src="zoomed.src" :alt="zoomed.alt" class="markdown-zoomed" />
        <v-card-actions>
          <span class="text-body-2 text-medium-emphasis text-truncate px-2">{{ zoomed.alt }}</span>
          <v-spacer />
          <v-btn :href="zoomed.src" target="_blank" rel="noopener">Open original</v-btn>
          <v-btn @click="zoomed = null">Close</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.markdown {
  overflow-wrap: anywhere;
  line-height: 1.5;
}
.markdown :deep(> :first-child) {
  margin-top: 0;
}
.markdown :deep(> :last-child) {
  margin-bottom: 0;
}
.markdown :deep(p),
.markdown :deep(ul),
.markdown :deep(ol),
.markdown :deep(pre),
.markdown :deep(blockquote),
.markdown :deep(table) {
  margin: 0 0 0.6em;
}
.markdown :deep(ul),
.markdown :deep(ol) {
  padding-left: 1.4em;
}
.markdown :deep(h1),
.markdown :deep(h2),
.markdown :deep(h3),
.markdown :deep(h4) {
  font-size: 1em;
  font-weight: 600;
  margin: 0.8em 0 0.4em;
}
.markdown :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85em;
  padding: 0.1em 0.3em;
  border-radius: 4px;
  background: rgba(var(--v-theme-on-surface), 0.08);
}
.markdown :deep(pre) {
  padding: 8px 10px;
  border-radius: 6px;
  overflow-x: auto;
  background: rgba(var(--v-theme-on-surface), 0.06);
}
.markdown :deep(pre code) {
  padding: 0;
  background: none;
}
.markdown :deep(blockquote) {
  padding-left: 0.8em;
  border-left: 3px solid rgba(var(--v-theme-on-surface), 0.2);
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}
.markdown :deep(a) {
  color: rgb(var(--v-theme-primary));
}
.markdown :deep(table) {
  border-collapse: collapse;
}
.markdown :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 4px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.markdown :deep(img:not(a img)) {
  cursor: zoom-in;
}
.markdown-zoomed {
  display: block;
  max-width: 100%;
  max-height: 80vh;
  margin: 0 auto;
  object-fit: contain;
}
.markdown :deep(th),
.markdown :deep(td) {
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  padding: 2px 8px;
}
</style>
