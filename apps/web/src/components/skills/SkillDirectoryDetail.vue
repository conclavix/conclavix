<script setup lang="ts">
import { mdiAlertOutline, mdiClose, mdiDownload, mdiOpenInNew } from '@mdi/js';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ApiError } from '../../api/client';
import {
  skillSourcesApi,
  type DirectoryDetail,
  type DirectoryQuota,
} from '../../api/skill-sources';
import { directoryErrorText, importState, suggestSkillName } from '../../skills/directory';
import { SKILL_NAME_PATTERN } from '../../stores/skills';

/** The detail dialog of one directory entry, with the guarded import flow. */
const props = defineProps<{ sourceId: string; slug: string | null }>();
const detailOpen = defineModel<boolean>({ required: true });
const emit = defineEmits<{
  imported: [skillId: string, externalId: string];
  quota: [quota: DirectoryQuota];
}>();

const detail = ref<DirectoryDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref<string | null>(null);

const importOpen = ref(false);
const importName = ref('');
const importConfirmed = ref(false);
const importReplace = ref(false);
const importBusy = ref(false);
const importError = ref<string | null>(null);
const importForm = ref<{ validate(): Promise<{ valid: boolean }> } | null>(null);

let detailVersion = 0;
onBeforeUnmount(() => {
  detailVersion += 1;
});

const state = computed(() => importState(detail.value));
const nameRules = [
  (value: string) =>
    SKILL_NAME_PATTERN.test(value) || 'lowercase letters, digits and single hyphens',
  (value: string) => value.length <= 64 || 'at most 64 characters',
];

async function load(id: string, slug: string): Promise<void> {
  const version = ++detailVersion;
  detail.value = null;
  detailError.value = null;
  detailLoading.value = true;
  try {
    const loaded = await skillSourcesApi.detail(id, slug);
    if (version !== detailVersion) return;
    detail.value = loaded;
    emit('quota', loaded.quota);
  } catch (cause) {
    if (version === detailVersion) detailError.value = directoryErrorText(cause);
  } finally {
    if (version === detailVersion) detailLoading.value = false;
  }
}

function startImport(): void {
  if (!detail.value || !state.value.allowed) return;
  importName.value = suggestSkillName(detail.value.skill.slug);
  importReplace.value = detail.value.importedSkillId !== null;
  importConfirmed.value = false;
  importError.value = null;
  importOpen.value = true;
}

async function confirmImport(): Promise<void> {
  const current = detail.value;
  if (!current || importBusy.value || !importConfirmed.value) return;
  if (!importReplace.value && !(await importForm.value?.validate())?.valid) return;
  importBusy.value = true;
  importError.value = null;
  try {
    const imported = await skillSourcesApi.import(props.sourceId, {
      slug: current.skill.slug,
      ...(importReplace.value ? { replaceExisting: true } : { name: importName.value }),
    });
    current.importedSkillId = imported.skill.id;
    importOpen.value = false;
    emit('imported', imported.skill.id, current.skill.externalId);
  } catch (cause) {
    if (cause instanceof ApiError && cause.code === 'already_imported') {
      importReplace.value = true;
      importError.value =
        'This skill was already imported. Confirm again to update the library copy.';
    } else {
      importError.value = directoryErrorText(cause);
    }
  } finally {
    importBusy.value = false;
  }
}

watch(
  () => [detailOpen.value, props.sourceId, props.slug] as const,
  ([open, id, slug]) => {
    if (open && slug) void load(id, slug);
  },
  { immediate: true },
);
</script>

<template>
  <div>
    <v-dialog v-model="detailOpen" max-width="760" scrollable>
      <v-card data-test="directory-detail">
        <v-card-title class="d-flex align-center">
          <span class="text-h6">{{ detail?.skill.name ?? 'Skill' }}</span>
          <v-spacer />
          <v-btn :icon="mdiClose" variant="text" aria-label="Close" @click="detailOpen = false" />
        </v-card-title>
        <v-card-text>
          <v-progress-linear v-if="detailLoading" indeterminate />
          <v-alert v-if="detailError" type="error" variant="tonal">{{ detailError }}</v-alert>
          <template v-if="detail">
            <p class="mb-2">{{ detail.skill.description }}</p>
            <div class="text-caption mb-2">
              By
              <a
                v-if="detail.skill.author.url"
                :href="detail.skill.author.url"
                target="_blank"
                rel="noopener noreferrer nofollow"
                >{{ detail.skill.author.name ?? 'unknown' }}</a
              >
              <span v-else>{{ detail.skill.author.name ?? 'unknown' }}</span>
              <span v-if="detail.skill.category"> · {{ detail.skill.category }}</span>
              <span v-if="detail.skill.stars !== null"> · {{ detail.skill.stars }} stars</span>
              <span v-if="detail.skill.verified"> · verified</span>
              <span v-if="detail.skill.securityGrade">
                · security grade {{ detail.skill.securityGrade }}
                <template v-if="detail.skill.securityScore !== null"
                  >({{ detail.skill.securityScore }})</template
                >
              </span>
            </div>
            <div class="d-flex flex-wrap ga-2 mb-3">
              <v-btn
                :href="detail.skill.webUrl"
                target="_blank"
                rel="noopener noreferrer"
                variant="text"
                size="small"
                :append-icon="mdiOpenInNew"
                >Open in directory</v-btn
              >
              <v-btn
                v-if="detail.skill.githubUrl"
                :href="detail.skill.githubUrl"
                target="_blank"
                rel="noopener noreferrer"
                variant="text"
                size="small"
                :append-icon="mdiOpenInNew"
                >GitHub</v-btn
              >
            </div>
            <v-alert
              v-if="detail.importedSkillId"
              type="success"
              variant="tonal"
              density="compact"
              class="mb-3"
            >
              Already in the library.
              <router-link :to="{ name: 'skills', query: { skill: detail.importedSkillId } }"
                >Open it</router-link
              >
            </v-alert>
            <template v-if="detail.content.available">
              <div class="text-subtitle-2 mb-1">Content preview</div>
              <pre class="directory-preview" data-test="directory-preview">{{
                detail.content.content
              }}</pre>
            </template>
            <v-alert
              v-else
              type="info"
              variant="tonal"
              density="compact"
              class="mb-3"
              data-test="directory-no-content"
            >
              {{ state.reason }}.
              <a v-if="state.url" :href="state.url" target="_blank" rel="noopener noreferrer"
                >Read the skill on the directory</a
              >
            </v-alert>
            <div class="d-flex align-center ga-2 mt-3">
              <v-btn
                color="primary"
                :prepend-icon="mdiDownload"
                :disabled="!state.allowed"
                data-test="directory-import"
                @click="startImport"
              >
                {{ detail.importedSkillId ? 'Update from directory' : 'Import' }}
              </v-btn>
            </div>
          </template>
        </v-card-text>
      </v-card>
    </v-dialog>

    <v-dialog v-model="importOpen" max-width="560" :persistent="importBusy">
      <v-card :title="importReplace ? 'Update imported skill' : 'Import skill'">
        <v-card-text>
          <v-alert type="warning" variant="tonal" :icon="mdiAlertOutline" class="mb-3">
            Imported skill text comes from a third party and becomes part of agent prompts. Read it
            before assigning the skill to an agent; Conclavix never assigns imported skills on its
            own.
          </v-alert>
          <v-form ref="importForm" :disabled="importBusy" @submit.prevent="confirmImport">
            <v-text-field
              v-if="!importReplace"
              v-model="importName"
              label="Skill name in the library"
              :rules="nameRules"
              class="mb-2"
              data-test="directory-import-name"
            />
            <p v-else class="text-body-2 mb-2">
              The library copy is replaced with the directory's current text. Supporting files and
              agent assignments stay as they are.
            </p>
            <v-checkbox
              v-model="importConfirmed"
              label="I have reviewed the content and want to import it"
              hide-details
              data-test="directory-import-confirm"
            />
          </v-form>
          <v-alert v-if="importError" type="error" variant="tonal" density="compact" class="mt-3">
            {{ importError }}
          </v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" :disabled="importBusy" @click="importOpen = false">Cancel</v-btn>
          <v-btn
            color="primary"
            variant="flat"
            :loading="importBusy"
            :disabled="!importConfirmed"
            data-test="directory-import-submit"
            @click="confirmImport"
          >
            {{ importReplace ? 'Update' : 'Import' }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.directory-preview {
  font-family: ui-monospace, monospace;
  font-size: 0.8rem;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 50vh;
  overflow: auto;
  padding: 12px;
  border-radius: 4px;
  background: rgba(var(--v-theme-on-surface), 0.05);
}
</style>
