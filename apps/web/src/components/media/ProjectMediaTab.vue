<script setup lang="ts">
import {
  mdiFilePdfBox,
  mdiImageMultipleOutline,
  mdiImageOffOutline,
  mdiMagnify,
  mdiPlayCircleOutline,
  mdiRefresh,
} from '@mdi/js';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { formatBytes } from '../../code/logic';
import { ago } from '../../format';
import { describeError } from '../../issues';
import { mediaApi, type MediaFilters, type MediaItem, type MediaListing } from '../../media/api';
import {
  KIND_LABELS,
  branchFilterLabel,
  hasThumbnail,
  issueKeys,
  mediaUrl,
  stepIndex,
} from '../../media/logic';
import MediaLightbox from './MediaLightbox.vue';

const props = defineProps<{ projectId: string; projectKey: string }>();

const PAGE_SIZE = 60;

const kind = ref<MediaFilters['kind'] | null>(null);
const branch = ref<string | null>(null);
const search = ref<string | null>('');
const sort = ref<MediaFilters['sort']>('newest');
/** The search text actually sent, debounced. */
const q = ref('');

const items = ref<MediaItem[]>([]);
const listing = ref<MediaListing | null>(null);
const loading = ref(false);
const error = ref('');
const broken = ref<Set<string>>(new Set());
const openIndex = ref<number | null>(null);

const filters = computed<MediaFilters>(() => ({
  kind: kind.value ?? undefined,
  branch: branch.value ?? undefined,
  q: q.value || undefined,
  sort: sort.value,
}));
const filtered = computed(() => !!(kind.value || branch.value || q.value));

const kindOptions = computed(() =>
  (['image', 'video', 'pdf'] as const).map((value) => ({
    value,
    title: `${KIND_LABELS[value]} (${listing.value?.facets.kinds[value] ?? 0})`,
  })),
);
const branchOptions = computed(() =>
  (listing.value?.facets.branches ?? []).map((b) => ({
    value: b.name,
    title: `${branchFilterLabel(b)} (${b.count})`,
  })),
);
const sortOptions = [
  { value: 'newest', title: 'Newest first' },
  { value: 'oldest', title: 'Oldest first' },
];

let seq = 0;
/** True while the first page for the current filters is loading; "Load more" waits for it. */
const reloading = ref(false);

/** `next` appended to `current` without items already shown (pages may overlap after a rescan). */
function appendNew(current: MediaItem[], next: MediaItem[]): MediaItem[] {
  const seen = new Set(current.map((item) => item.oid));
  return [...current, ...next.filter((item) => !seen.has(item.oid))];
}

/**
 * Load the first page for the current filters, or append the next page with `more`. A next page
 * from a newer scan (a branch moved meanwhile) does not continue the list, so it starts over.
 */
async function load(more = false): Promise<void> {
  if (more && (reloading.value || listing.value?.nextOffset == null)) return;
  const id = ++seq;
  const offset = more ? (listing.value?.nextOffset ?? 0) : 0;
  const version = listing.value?.version;
  loading.value = true;
  reloading.value = !more;
  error.value = '';
  try {
    const page = await mediaApi.list(props.projectId, filters.value, offset, PAGE_SIZE);
    if (id === seq) apply(page, more, version);
  } catch (cause) {
    if (id === seq) error.value = describeError(cause);
  } finally {
    if (id === seq) {
      loading.value = false;
      reloading.value = false;
    }
  }
}

/** Show a loaded page; a next page of another scan version restarts the list instead. */
function apply(page: MediaListing, more: boolean, version: string | undefined): void {
  if (more && page.version !== version) {
    void load();
    return;
  }
  listing.value = page;
  items.value = more ? appendNew(items.value, page.items) : page.items;
  if (!more) openIndex.value = null;
}

let debounce: ReturnType<typeof setTimeout> | undefined;
watch(search, (value) => {
  clearTimeout(debounce);
  debounce = setTimeout(() => (q.value = (value ?? '').trim()), 300);
});
onBeforeUnmount(() => clearTimeout(debounce));

watch(
  () => [props.projectId, filters.value.kind, filters.value.branch, filters.value.q, sort.value],
  () => void load(),
  { immediate: true },
);

const current = computed(() =>
  openIndex.value === null ? null : (items.value[openIndex.value] ?? null),
);
const hasNext = computed(
  () =>
    openIndex.value !== null &&
    (openIndex.value + 1 < items.value.length || listing.value?.nextOffset != null),
);
const position = computed(() =>
  openIndex.value === null
    ? ''
    : `${openIndex.value + 1} / ${listing.value?.total ?? items.value.length}`,
);

async function step(delta: 1 | -1): Promise<void> {
  if (openIndex.value === null) return;
  let next = stepIndex(openIndex.value, delta, items.value.length);
  if (next === null && delta > 0 && listing.value?.nextOffset != null) {
    await load(true);
    // A rescan restarted the list and closed the lightbox.
    if (openIndex.value === null) return;
    next = stepIndex(openIndex.value, delta, items.value.length);
  }
  if (next !== null) openIndex.value = next;
}

function markBroken(oid: string): void {
  broken.value = new Set([...broken.value, oid]);
}

const subtitle = (item: MediaItem): string => {
  const parts = [formatBytes(item.size)];
  if (item.commit) parts.push(`${ago(item.commit.committedAt)} ago`);
  return parts.join(' · ');
};
</script>

<template>
  <div data-test="media-tab">
    <div class="d-flex flex-wrap align-center ga-2 mb-3">
      <v-select
        v-model="kind"
        :items="kindOptions"
        label="Type"
        density="compact"
        variant="outlined"
        clearable
        hide-details
        class="media-filter"
        data-test="media-kind"
      />
      <v-select
        v-model="branch"
        :items="branchOptions"
        label="Branch / issue"
        density="compact"
        variant="outlined"
        clearable
        hide-details
        class="media-filter media-filter--wide"
        data-test="media-branch"
      />
      <v-text-field
        v-model="search"
        placeholder="Search path"
        aria-label="Search path"
        :prepend-inner-icon="mdiMagnify"
        density="compact"
        variant="outlined"
        clearable
        hide-details
        class="media-filter media-filter--wide"
        data-test="media-search"
      />
      <v-select
        v-model="sort"
        :items="sortOptions"
        label="Sort"
        density="compact"
        variant="outlined"
        hide-details
        class="media-filter"
        data-test="media-sort"
      />
      <v-spacer />
      <span v-if="listing" class="text-body-2 text-medium-emphasis" data-test="media-count">
        {{ listing.total }} {{ listing.total === 1 ? 'file' : 'files' }}
      </span>
      <v-btn
        :icon="mdiRefresh"
        variant="text"
        size="small"
        aria-label="Refresh"
        :loading="loading"
        @click="load()"
      />
    </div>

    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">
      {{ error }}
    </v-alert>
    <v-alert
      v-if="listing?.truncated"
      type="info"
      variant="tonal"
      density="compact"
      class="mb-3"
      data-test="media-truncated"
    >
      The scan stopped at a size or time limit after {{ listing.scannedBranches }} branches; some
      files may be missing.
    </v-alert>

    <v-progress-linear v-if="loading && items.length === 0" indeterminate class="mb-3" />

    <v-card
      v-if="listing && items.length === 0 && !loading"
      variant="flat"
      border
      rounded="lg"
      class="pa-8 text-center"
      data-test="media-empty"
    >
      <v-icon :icon="mdiImageMultipleOutline" size="48" class="text-medium-emphasis mb-2" />
      <template v-if="filtered">
        <div class="text-subtitle-1">No media matches these filters</div>
      </template>
      <template v-else>
        <div class="text-subtitle-1 mb-1">No media in this project yet</div>
        <div class="text-body-2 text-medium-emphasis media-empty-text">
          Images, videos and PDFs committed to <code>main</code> or to an issue branch
          (<code>cvx/&lt;KEY&gt;</code>) show up here. Agents commit their screenshots under
          <code>docs/screenshots/&lt;module&gt;/</code> on the issue's branch, so they appear as
          soon as the agent's work is synced.
        </div>
      </template>
    </v-card>

    <div v-if="items.length > 0" class="media-grid" data-test="media-grid">
      <v-card
        v-for="(item, index) in items"
        :key="item.oid"
        variant="flat"
        border
        rounded="lg"
        class="media-card"
        :data-test="`media-item-${index}`"
        @click="openIndex = index"
      >
        <div class="media-thumb">
          <img
            v-if="hasThumbnail(item) && !broken.has(item.oid)"
            :src="mediaUrl(projectId, item)"
            :alt="item.path"
            loading="lazy"
            decoding="async"
            data-test="media-thumb"
            @error="markBroken(item.oid)"
          />
          <v-icon
            v-else-if="item.kind === 'video'"
            :icon="mdiPlayCircleOutline"
            size="56"
            class="text-medium-emphasis"
          />
          <v-icon v-else-if="item.kind === 'pdf'" :icon="mdiFilePdfBox" size="56" color="error" />
          <v-icon v-else :icon="mdiImageOffOutline" size="48" class="text-medium-emphasis" />
        </div>
        <div class="pa-2">
          <div class="text-body-2 font-weight-medium text-truncate" :title="item.path">
            {{ item.name }}
          </div>
          <div class="text-caption text-medium-emphasis text-truncate" :title="item.path">
            {{ item.path }}
          </div>
          <div class="d-flex align-center ga-1 mt-1">
            <span class="text-caption text-medium-emphasis text-truncate">{{
              subtitle(item)
            }}</span>
            <v-spacer />
            <v-chip
              v-for="key in issueKeys(item).slice(0, 2)"
              :key="key"
              size="x-small"
              label
              color="primary"
              variant="tonal"
            >
              {{ key }}
            </v-chip>
            <v-chip v-if="issueKeys(item).length > 2" size="x-small" label variant="tonal">
              +{{ issueKeys(item).length - 2 }}
            </v-chip>
          </div>
        </div>
      </v-card>
    </div>

    <div v-if="listing?.nextOffset != null" class="d-flex justify-center mt-4">
      <v-btn
        variant="tonal"
        :loading="loading"
        :disabled="reloading"
        data-test="media-more"
        @click="load(true)"
      >
        Load more
      </v-btn>
    </div>

    <MediaLightbox
      :item="current"
      :project-id="projectId"
      :project-key="projectKey"
      :has-prev="(openIndex ?? 0) > 0"
      :has-next="hasNext"
      :position="position"
      @close="openIndex = null"
      @prev="step(-1)"
      @next="step(1)"
    />
  </div>
</template>

<style scoped>
.media-filter {
  min-width: 150px;
  max-width: 200px;
}
.media-filter--wide {
  min-width: 200px;
  max-width: 300px;
}
.media-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
}
.media-card {
  cursor: pointer;
  overflow: hidden;
}
.media-thumb {
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 4 / 3;
  background: rgba(var(--v-theme-on-surface), 0.04);
  border-bottom: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.media-thumb img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.media-empty-text {
  max-width: 560px;
  margin: 0 auto;
}
@media (max-width: 600px) {
  .media-filter,
  .media-filter--wide {
    max-width: none;
    flex: 1 1 100%;
  }
  .media-grid {
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  }
}
</style>
