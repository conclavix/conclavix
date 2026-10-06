<script setup lang="ts">
import { mdiCheckDecagram, mdiMagnify, mdiShieldCheckOutline, mdiStar } from '@mdi/js';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  skillSourcesApi,
  type DirectoryCategory,
  type DirectoryQuery,
  type DirectoryQuota,
  type DirectorySearchResult,
  type DirectorySkill,
  type SkillSource,
} from '../../api/skill-sources';
import { directoryErrorText, providerLabel, quotaText, safeImageUrl } from '../../skills/directory';
import SkillDirectoryDetail from './SkillDirectoryDetail.vue';

const emit = defineEmits<{ imported: [skillId: string] }>();

const SORTS = [
  { title: 'Most recent', value: 'recent' },
  { title: 'Most votes', value: 'votes' },
  { title: 'Most GitHub stars', value: 'stars' },
] as const;
const PAGE_SIZE = 12;

const sources = ref<SkillSource[]>([]);
const sourcesLoaded = ref(false);
const sourceId = ref<string | null>(null);
const categories = ref<DirectoryCategory[]>([]);
const search = ref('');
const category = ref<string | null>(null);
const sort = ref<DirectoryQuery['sort']>('recent');
const page = ref(1);
const result = ref<DirectorySearchResult | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const categoryError = ref<string | null>(null);
const detailOpen = ref(false);
const detailSlug = ref<string | null>(null);
const detailQuota = ref<DirectoryQuota | null>(null);

let searchVersion = 0;
onBeforeUnmount(() => {
  searchVersion += 1;
});

const source = computed(() => sources.value.find((entry) => entry.id === sourceId.value) ?? null);
const quota = computed(() => quotaText(detailQuota.value ?? result.value?.quota));
const pages = computed(() => Math.min(result.value?.totalPages ?? 1, 1000));
const categoryItems = computed(() =>
  categories.value.map((entry) => ({ title: entry.name, value: entry.slug })),
);

async function loadCategories(id: string): Promise<void> {
  categoryError.value = null;
  try {
    const list = await skillSourcesApi.categories(id);
    if (id === sourceId.value) categories.value = list.items;
  } catch (cause) {
    if (id !== sourceId.value) return;
    categories.value = [];
    categoryError.value = `Categories could not be loaded: ${directoryErrorText(cause)}`;
  }
}

async function runSearch(): Promise<void> {
  const id = sourceId.value;
  if (!id) return;
  const version = ++searchVersion;
  loading.value = true;
  error.value = null;
  try {
    const found = await skillSourcesApi.search(id, {
      q: search.value ?? '',
      ...(category.value ? { category: category.value } : {}),
      sort: sort.value,
      page: page.value,
      limit: PAGE_SIZE,
    });
    if (version !== searchVersion) return;
    result.value = found;
    detailQuota.value = null;
  } catch (cause) {
    if (version === searchVersion) error.value = directoryErrorText(cause);
  } finally {
    if (version === searchVersion) loading.value = false;
  }
}

/** A new query starts on page 1; searching only on submit spares the directory's daily budget. */
function submitSearch(): void {
  page.value = 1;
  void runSearch();
}

function goToPage(value: number): void {
  page.value = value;
  void runSearch();
}

function selectSource(id: string | null): void {
  sourceId.value = id;
  result.value = null;
  categories.value = [];
  category.value = null;
  detailQuota.value = null;
  page.value = 1;
  if (id) {
    void loadCategories(id);
    void runSearch();
  }
}

async function loadSources(): Promise<void> {
  try {
    const list = await skillSourcesApi.list();
    sources.value = list.items.filter((entry) => entry.enabled);
    selectSource(sources.value[0]?.id ?? null);
  } catch (cause) {
    error.value = directoryErrorText(cause);
  } finally {
    sourcesLoaded.value = true;
  }
}

function openDetail(item: DirectorySkill): void {
  detailSlug.value = item.slug;
  detailOpen.value = true;
}

function onImported(skillId: string, externalId: string): void {
  if (result.value) {
    result.value.items = result.value.items.map((item) =>
      item.externalId === externalId ? { ...item, importedSkillId: skillId } : item,
    );
  }
  emit('imported', skillId);
}

onMounted(loadSources);
</script>

<template>
  <div>
    <v-alert
      v-if="sourcesLoaded && sources.length === 0 && !error"
      type="info"
      variant="tonal"
      data-test="directory-empty"
    >
      No skill directory is set up yet. Owners and admins add one under
      <router-link :to="{ name: 'admin-skill-directories' }"
        >Administration: Skill directories</router-link
      >.
    </v-alert>
    <template v-if="sources.length > 0">
      <v-row dense class="align-center">
        <v-col cols="12" md="3">
          <v-select
            :model-value="sourceId"
            label="Directory"
            :items="sources"
            item-title="name"
            item-value="id"
            density="compact"
            hide-details
            data-test="directory-source"
            @update:model-value="selectSource"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model="search"
            label="Search"
            density="compact"
            hide-details
            clearable
            :append-inner-icon="mdiMagnify"
            data-test="directory-search"
            @keydown.enter="submitSearch"
            @click:append-inner="submitSearch"
            @click:clear="submitSearch"
          />
        </v-col>
        <v-col cols="6" md="2">
          <v-select
            v-model="category"
            label="Category"
            :items="categoryItems"
            density="compact"
            :hide-details="!categoryError"
            :error-messages="categoryError"
            clearable
            data-test="directory-category"
            @update:model-value="submitSearch"
          />
        </v-col>
        <v-col cols="6" md="2">
          <v-select
            v-model="sort"
            label="Sort"
            :items="SORTS"
            density="compact"
            hide-details
            @update:model-value="submitSearch"
          />
        </v-col>
        <v-col cols="12" md="1" class="text-md-right">
          <v-btn color="primary" :loading="loading" @click="submitSearch">Search</v-btn>
        </v-col>
      </v-row>
      <div class="d-flex align-center flex-wrap ga-2 my-2 text-caption text-medium-emphasis">
        <span v-if="source">{{ providerLabel(source.provider) }}</span>
        <v-chip v-if="quota" size="small" variant="tonal" data-test="directory-quota">
          {{ quota }}
        </v-chip>
        <span v-if="result">{{ result.total }} {{ result.total === 1 ? 'skill' : 'skills' }}</span>
      </div>
      <v-alert v-if="error" type="error" variant="tonal" class="mb-2" data-test="directory-error">
        {{ error }}
      </v-alert>
      <v-progress-linear v-if="loading" indeterminate class="mb-2" />
      <v-row dense>
        <v-col v-for="item in result?.items ?? []" :key="item.externalId" cols="12" sm="6" lg="4">
          <v-card
            variant="outlined"
            class="h-100 d-flex flex-column"
            :data-test="`directory-card-${item.slug}`"
            @click="openDetail(item)"
          >
            <v-card-item>
              <template #prepend>
                <v-avatar size="36" color="surface-variant">
                  <v-img
                    v-if="safeImageUrl(item.author.avatarUrl)"
                    :src="safeImageUrl(item.author.avatarUrl) ?? ''"
                    :alt="item.author.name ?? ''"
                    referrerpolicy="no-referrer"
                  />
                  <span v-else>{{
                    (item.author.name ?? item.name).slice(0, 1).toUpperCase()
                  }}</span>
                </v-avatar>
              </template>
              <v-card-title class="text-subtitle-1 d-flex align-center ga-1">
                <span class="text-truncate">{{ item.name }}</span>
                <v-icon
                  v-if="item.verified"
                  :icon="mdiCheckDecagram"
                  size="small"
                  color="primary"
                  aria-label="verified"
                />
              </v-card-title>
              <v-card-subtitle>{{ item.author.name ?? 'Unknown author' }}</v-card-subtitle>
            </v-card-item>
            <v-card-text class="flex-grow-1">
              <p class="directory-card__description">{{ item.description }}</p>
              <div class="d-flex flex-wrap ga-1 mt-2">
                <v-chip
                  v-for="tag in item.tags.slice(0, 5)"
                  :key="tag"
                  size="x-small"
                  variant="tonal"
                >
                  {{ tag }}
                </v-chip>
              </div>
            </v-card-text>
            <v-card-actions class="text-caption">
              <span v-if="item.stars !== null" class="d-flex align-center ga-1 ml-2">
                <v-icon :icon="mdiStar" size="small" />{{ item.stars }}
              </span>
              <v-chip
                v-if="item.securityGrade"
                size="x-small"
                :prepend-icon="mdiShieldCheckOutline"
                class="ml-2"
              >
                Security {{ item.securityGrade }}
              </v-chip>
              <v-spacer />
              <v-chip v-if="item.importedSkillId" size="x-small" color="success" variant="tonal">
                In library
              </v-chip>
            </v-card-actions>
          </v-card>
        </v-col>
      </v-row>
      <div v-if="result && !loading && result.items.length === 0" class="text-medium-emphasis pa-4">
        No skills match.
      </div>
      <v-pagination
        v-if="result && pages > 1"
        :model-value="page"
        :length="pages"
        :total-visible="7"
        density="comfortable"
        class="mt-2"
        @update:model-value="goToPage"
      />
    </template>

    <SkillDirectoryDetail
      v-if="sourceId"
      v-model="detailOpen"
      :source-id="sourceId"
      :slug="detailSlug"
      @quota="(value) => (detailQuota = value)"
      @imported="onImported"
    />
  </div>
</template>

<style scoped>
.directory-card__description {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
