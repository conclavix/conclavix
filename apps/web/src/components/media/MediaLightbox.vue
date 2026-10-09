<script setup lang="ts">
import {
  mdiChevronLeft,
  mdiChevronRight,
  mdiClose,
  mdiCodeTags,
  mdiDownload,
  mdiFilePdfBox,
  mdiMagnifyMinusOutline,
  mdiMagnifyPlusOutline,
  mdiFitToScreenOutline,
} from '@mdi/js';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { formatBytes } from '../../code/logic';
import type { MediaItem } from '../../media/api';
import { branchesOf, codeTabLink, issueKeys, mediaUrl, tooLarge } from '../../media/logic';

const props = defineProps<{
  item: MediaItem | null;
  projectId: string;
  projectKey: string;
  hasPrev: boolean;
  hasNext: boolean;
  /** Position label such as "3 / 40". */
  position: string;
}>();
const emit = defineEmits<{ close: []; prev: []; next: [] }>();

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEPS = [MIN_ZOOM, 0.5, 1, 1.5, 2, 3, MAX_ZOOM];
/** null fits the image into the view; a number scales its natural size. */
const zoom = ref<number | null>(null);
const natural = ref<{ width: number; height: number } | null>(null);

watch(
  () => props.item?.oid,
  () => {
    zoom.value = null;
    natural.value = null;
  },
);

const url = computed(() => (props.item ? mediaUrl(props.projectId, props.item) : ''));
const blocked = computed(() => (props.item ? tooLarge(props.item) : false));
const imageStyle = computed(() =>
  zoom.value === null || !natural.value
    ? { maxWidth: '100%', maxHeight: '70vh' }
    : { width: `${natural.value.width * zoom.value}px`, maxWidth: 'none', maxHeight: 'none' },
);
const zoomLabel = computed(() =>
  zoom.value === null ? 'Fit' : `${Math.round(zoom.value * 100)}%`,
);
const committed = computed(() =>
  props.item?.commit ? new Date(props.item.commit.committedAt).toLocaleString() : '',
);

function loaded(event: Event): void {
  const img = event.target as HTMLImageElement;
  natural.value = { width: img.naturalWidth, height: img.naturalHeight };
}

/** The current scale against the natural size, also while fitting. */
function currentScale(): number {
  if (zoom.value !== null) return zoom.value;
  const img = document.querySelector<HTMLImageElement>('[data-test="lightbox-image"]');
  if (!img || !natural.value?.width) return 1;
  return img.clientWidth / natural.value.width;
}

function zoomBy(direction: 1 | -1): void {
  const scale = currentScale();
  const next =
    direction > 0
      ? ZOOM_STEPS.find((step) => step > scale + 0.01)
      : [...ZOOM_STEPS].reverse().find((step) => step < scale - 0.01);
  zoom.value = next ?? (direction > 0 ? MAX_ZOOM : MIN_ZOOM);
}

const toggleZoom = (): void => {
  zoom.value = zoom.value === null ? 1 : null;
};

function onKey(event: KeyboardEvent): void {
  if (!props.item) return;
  const target = event.target;
  if (target instanceof Element && target.closest('input, textarea, video')) return;
  if (event.key === 'ArrowLeft' && props.hasPrev) emit('prev');
  else if (event.key === 'ArrowRight' && props.hasNext) emit('next');
  else if (event.key === '+' || event.key === '=') zoomBy(1);
  else if (event.key === '-') zoomBy(-1);
  else return;
  event.preventDefault();
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <v-dialog
    :model-value="item !== null"
    max-width="1280"
    scrollable
    @update:model-value="(open: boolean) => !open && emit('close')"
  >
    <v-card v-if="item" rounded="lg" data-test="media-lightbox">
      <div class="d-flex align-center ga-1 px-3 py-2 media-lightbox-bar">
        <div class="text-truncate">
          <div class="font-weight-medium text-truncate" data-test="lightbox-name">
            {{ item.name }}
          </div>
          <div class="text-caption text-medium-emphasis text-truncate">{{ item.path }}</div>
        </div>
        <v-spacer />
        <span class="text-caption text-medium-emphasis mr-2" data-test="lightbox-position">
          {{ position }}
        </span>
        <template v-if="item.kind === 'image' && !blocked">
          <v-btn
            :icon="mdiMagnifyMinusOutline"
            variant="text"
            size="small"
            aria-label="Zoom out"
            data-test="zoom-out"
            @click="zoomBy(-1)"
          />
          <v-btn
            variant="text"
            size="small"
            class="px-1"
            :prepend-icon="mdiFitToScreenOutline"
            aria-label="Fit to view or show actual size"
            data-test="zoom-reset"
            @click="toggleZoom"
          >
            {{ zoomLabel }}
          </v-btn>
          <v-btn
            :icon="mdiMagnifyPlusOutline"
            variant="text"
            size="small"
            aria-label="Zoom in"
            data-test="zoom-in"
            @click="zoomBy(1)"
          />
        </template>
        <v-btn
          :icon="mdiClose"
          variant="text"
          size="small"
          aria-label="Close"
          data-test="lightbox-close"
          @click="emit('close')"
        />
      </div>
      <v-divider />
      <div class="media-lightbox-frame">
        <v-btn
          v-if="hasPrev"
          :icon="mdiChevronLeft"
          class="media-lightbox-nav media-lightbox-nav--prev"
          variant="flat"
          aria-label="Previous"
          data-test="lightbox-prev"
          @click="emit('prev')"
        />
        <div
          class="media-lightbox-stage"
          :class="{ 'media-lightbox-stage--zoomed': zoom !== null }"
        >
          <v-alert
            v-if="blocked"
            type="info"
            variant="tonal"
            density="compact"
            class="ma-6"
            data-test="lightbox-too-large"
          >
            This file is larger than 10 MB and cannot be previewed. Download the ZIP from the Code
            tab to get it.
          </v-alert>
          <img
            v-else-if="item.kind === 'image'"
            :key="url"
            :src="url"
            :alt="item.path"
            :style="imageStyle"
            class="media-lightbox-image"
            data-test="lightbox-image"
            @load="loaded"
            @click="toggleZoom"
          />
          <video
            v-else-if="item.kind === 'video'"
            :key="url"
            :src="url"
            controls
            preload="metadata"
            class="media-lightbox-video"
            data-test="lightbox-video"
          />
          <div v-else class="text-center pa-10" data-test="lightbox-pdf">
            <v-icon :icon="mdiFilePdfBox" size="96" color="error" />
            <div class="text-body-2 text-medium-emphasis mt-2">
              PDFs are not shown in the browser; download the file to open it.
            </div>
          </div>
        </div>
        <v-btn
          v-if="hasNext"
          :icon="mdiChevronRight"
          class="media-lightbox-nav media-lightbox-nav--next"
          variant="flat"
          aria-label="Next"
          data-test="lightbox-next"
          @click="emit('next')"
        />
      </div>
      <v-divider />
      <div class="d-flex flex-wrap align-center ga-2 px-3 py-2">
        <span class="text-caption text-medium-emphasis" data-test="lightbox-meta">
          {{ formatBytes(item.size) }}
          <template v-if="item.commit"> · {{ item.commit.authorName }} · {{ committed }} </template>
        </span>
        <v-chip
          v-for="branch in branchesOf(item)"
          :key="branch"
          size="x-small"
          label
          variant="outlined"
        >
          {{ branch }}
        </v-chip>
        <v-spacer />
        <v-btn
          v-for="key in issueKeys(item)"
          :key="key"
          :to="{ name: 'issue', params: { issueKey: key } }"
          variant="tonal"
          size="small"
          data-test="lightbox-issue"
        >
          {{ key }}
        </v-btn>
        <v-btn
          :to="codeTabLink(projectKey, item)"
          :prepend-icon="mdiCodeTags"
          variant="tonal"
          size="small"
          data-test="lightbox-code"
        >
          Open in Code tab
        </v-btn>
        <v-btn
          v-if="!blocked"
          :href="url"
          :download="item.name"
          :prepend-icon="mdiDownload"
          color="primary"
          variant="flat"
          size="small"
          data-test="lightbox-download"
        >
          Download
        </v-btn>
      </div>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.media-lightbox-bar {
  min-height: 52px;
}
.media-lightbox-stage {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 320px;
  max-height: 72vh;
  overflow: auto;
  background: rgba(var(--v-theme-on-surface), 0.04);
}
.media-lightbox-stage--zoomed {
  align-items: flex-start;
  justify-content: flex-start;
}
.media-lightbox-image {
  display: block;
  margin: auto;
  cursor: zoom-in;
  background: repeating-conic-gradient(rgba(128, 128, 128, 0.15) 0% 25%, transparent 0% 50%) 50% /
    16px 16px;
}
.media-lightbox-stage--zoomed .media-lightbox-image {
  cursor: zoom-out;
}
.media-lightbox-video {
  display: block;
  max-width: 100%;
  max-height: 70vh;
}
.media-lightbox-frame {
  position: relative;
}
.media-lightbox-nav {
  position: absolute;
  top: 50%;
  z-index: 1;
  transform: translateY(-50%);
  opacity: 0.85;
}
.media-lightbox-nav--prev {
  left: 8px;
}
.media-lightbox-nav--next {
  right: 8px;
}
</style>
