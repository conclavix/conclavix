<script setup lang="ts">
import { mdiChevronDown, mdiChevronUp } from '@mdi/js';
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import MarkdownBlock from '../MarkdownBlock.vue';

const props = withDefaults(defineProps<{ source: string; lines?: number }>(), { lines: 4 });

const body = ref<HTMLElement | null>(null);
const expanded = ref(false);
const overflowing = ref(false);
let observer: ResizeObserver | undefined;

/** Whether the clamped text hides anything; only then is the toggle worth showing. */
function measure(): void {
  const el = body.value;
  if (!el || expanded.value) return;
  overflowing.value = el.scrollHeight > el.clientHeight + 1;
}

onMounted(() => {
  measure();
  if (typeof ResizeObserver !== 'undefined' && body.value) {
    observer = new ResizeObserver(measure);
    observer.observe(body.value);
  }
});
onBeforeUnmount(() => observer?.disconnect());
watch(
  () => props.source,
  async () => {
    expanded.value = false;
    await nextTick();
    measure();
  },
);
</script>

<template>
  <div class="project-description" data-test="project-description">
    <div
      ref="body"
      class="project-description__body text-body-2"
      :class="{
        'project-description__body--clamped': !expanded,
        'project-description__body--faded': !expanded && overflowing,
      }"
      :style="{ '--clamp-lines': lines }"
      @load.capture="measure"
    >
      <MarkdownBlock :source="source" />
    </div>
    <v-btn
      v-if="overflowing || expanded"
      variant="text"
      size="small"
      density="comfortable"
      color="primary"
      class="mt-1 px-1"
      :append-icon="expanded ? mdiChevronUp : mdiChevronDown"
      :aria-expanded="expanded"
      data-test="description-toggle"
      @click="expanded = !expanded"
    >
      {{ expanded ? 'Show less' : 'Show more' }}
    </v-btn>
  </div>
</template>

<style scoped>
.project-description__body {
  color: rgba(var(--v-theme-on-surface), var(--v-high-emphasis-opacity));
  line-height: 1.5;
}
.project-description__body--clamped {
  max-height: calc(var(--clamp-lines) * 1.5em);
  overflow: hidden;
}
.project-description__body--faded {
  mask-image: linear-gradient(to bottom, black 55%, transparent);
}
.project-description__body :deep(h1),
.project-description__body :deep(h2),
.project-description__body :deep(h3),
.project-description__body :deep(h4) {
  font-size: 0.875rem;
  letter-spacing: 0.01em;
}
.project-description__body :deep(li + li) {
  margin-top: 2px;
}
</style>
