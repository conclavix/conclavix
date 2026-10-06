<script setup lang="ts">
import { mdiPlus } from '@mdi/js';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { isAdminRole } from '../admin/gating';
import { loadAgents } from '../agents/api';
import SkillDirectoryBrowser from '../components/skills/SkillDirectoryBrowser.vue';
import { providerLabel } from '../skills/directory';
import { useAuthStore } from '../stores/auth';
import { skillUsage } from '../agents/skills';
import type { Agent, Skill, SkillDraft } from '../api/types';
import { SKILL_NAME_PATTERN, useSkillsStore } from '../stores/skills';

/**
 * `skill` (from ?skill=<id>) opens that skill, e.g. when following a link from an agent; `tab`
 * (?tab=directory) opens the directory browser, which only owners and admins see.
 */
const props = defineProps<{ skill?: string | undefined; tab?: string | undefined }>();
const skills = useSkillsStore();
const auth = useAuthStore();
const router = useRouter();
const canImport = computed(() => isAdminRole(auth.me?.role));
const activeTab = ref<'library' | 'directory'>('library');
watch(
  [() => props.tab, canImport],
  ([value, allowed]) => {
    activeTab.value = value === 'directory' && allowed ? 'directory' : 'library';
  },
  { immediate: true },
);

/** After an import: show the library with the new skill opened. */
async function onImported(id: string): Promise<void> {
  await skills.refresh();
  activeTab.value = 'library';
  await router.replace({ name: 'skills', query: { skill: id } });
  if (selected.value?.id !== id) await open(id);
}
const agents = ref<Pick<Agent, 'id' | 'name' | 'skillIds'>[]>([]);
/** null until the agents are loaded; false when loading failed, so no usage is claimed. */
const usageKnown = ref<boolean | null>(null);
const usage = computed(() => skillUsage(agents.value));
const usedBy = computed(() => (selected.value ? (usage.value[selected.value.id] ?? []) : []));
const selected = ref<Skill | null>(null);
const editing = ref(false);
const draft = ref<SkillDraft>({ name: '', description: '', body: '' });
const error = ref('');
const saving = ref(false);
const loading = ref(false);
let editorVersion = 0;
const confirmDelete = ref(false);
const form = ref<{ validate(): Promise<{ valid: boolean }> } | null>(null);

const nameRules = [
  (value: string) =>
    SKILL_NAME_PATTERN.test(value) || 'lowercase letters, digits and single hyphens',
  (value: string) => value.length <= 64 || 'at most 64 characters',
];
const descriptionRules = [
  (value: string) => value.trim().length > 0 || 'required',
  (value: string) => !/[\r\n]/.test(value) || 'single line',
  (value: string) => value.length <= 1024 || 'at most 1024 characters',
];
const title = computed(() => (selected.value ? `Edit ${selected.value.name}` : 'New skill'));

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

function startNew(): void {
  if (saving.value) return;
  ++editorVersion;
  loading.value = false;
  confirmDelete.value = false;
  selected.value = null;
  draft.value = { name: '', description: '', body: '' };
  error.value = '';
  editing.value = true;
}

async function open(id: string): Promise<void> {
  if (saving.value) return;
  const version = ++editorVersion;
  loading.value = true;
  confirmDelete.value = false;
  error.value = '';
  try {
    const skill = await skills.get(id);
    if (version !== editorVersion) return;
    selected.value = skill;
    draft.value = { name: skill.name, description: skill.description, body: skill.body };
    editing.value = true;
  } catch (cause) {
    if (version === editorVersion) error.value = message(cause);
  } finally {
    if (version === editorVersion) loading.value = false;
  }
}

async function save(): Promise<void> {
  if (saving.value || loading.value || !editing.value) return;
  const version = editorVersion;
  const id = selected.value?.id;
  saving.value = true;
  error.value = '';
  try {
    if (!(await form.value?.validate())?.valid || version !== editorVersion) return;
    const saved = await skills.save({ ...draft.value }, id);
    if (version === editorVersion) selected.value = saved;
  } catch (cause) {
    if (version === editorVersion) error.value = message(cause);
  } finally {
    saving.value = false;
  }
}

async function remove(): Promise<void> {
  if (saving.value || loading.value || !selected.value) return;
  const version = editorVersion;
  const id = selected.value.id;
  confirmDelete.value = false;
  saving.value = true;
  error.value = '';
  try {
    await skills.remove(id);
    if (version === editorVersion) {
      selected.value = null;
      editing.value = false;
    }
  } catch (cause) {
    if (version === editorVersion) error.value = message(cause);
  } finally {
    saving.value = false;
  }
}

function close(): void {
  if (saving.value) return;
  ++editorVersion;
  loading.value = false;
  confirmDelete.value = false;
  editing.value = false;
}

/** Usage is informative only: a failure says so instead of blocking the editor. */
async function loadUsage(): Promise<void> {
  try {
    agents.value = await loadAgents();
    usageKnown.value = true;
  } catch {
    agents.value = [];
    usageKnown.value = false;
  }
}

onBeforeUnmount(() => ++editorVersion);
onMounted(() => {
  void skills.refresh();
  void loadUsage();
});
watch(
  () => props.skill,
  (id) => {
    if (id && id !== selected.value?.id) void open(id);
  },
  { immediate: true },
);
</script>

<template>
  <v-container fluid class="pa-3">
    <v-tabs v-if="canImport" v-model="activeTab" density="compact" class="mb-2">
      <v-tab value="library">Library</v-tab>
      <v-tab value="directory" data-test="skills-directory-tab">Directory</v-tab>
    </v-tabs>
    <SkillDirectoryBrowser v-if="activeTab === 'directory'" @imported="onImported" />
    <template v-else>
      <v-alert v-if="error" type="error" variant="tonal" class="mb-2" data-test="skill-error">
        {{ error }}
      </v-alert>
      <v-alert v-if="skills.refreshError" type="warning" variant="tonal" class="mb-2">
        {{ skills.refreshError }}
        <v-btn variant="text" @click="skills.refresh">Refresh</v-btn>
      </v-alert>
      <v-progress-linear v-if="loading" indeterminate aria-label="Loading skill" />
      <v-row dense>
        <v-col cols="12" md="4">
          <v-card variant="tonal">
            <v-card-title class="d-flex align-center text-subtitle-1">
              Skills
              <v-spacer />
              <v-btn
                :prepend-icon="mdiPlus"
                size="small"
                variant="text"
                :disabled="saving"
                @click="startNew"
                >New</v-btn
              >
            </v-card-title>
            <v-list density="compact" bg-color="transparent">
              <v-list-item
                v-for="skill in skills.items"
                :key="skill.id"
                :disabled="saving"
                :title="skill.name"
                :subtitle="skill.description"
                :active="selected?.id === skill.id"
                @click="open(skill.id)"
              >
                <template
                  v-if="skill.fileCount > 0 || usage[skill.id] || skill.sourceProvider"
                  #append
                >
                  <v-chip
                    v-if="skill.sourceProvider"
                    size="small"
                    variant="tonal"
                    class="mr-1"
                    :title="`Imported from ${providerLabel(skill.sourceProvider)}`"
                    >imported</v-chip
                  >
                  <v-chip
                    v-if="usage[skill.id]"
                    size="small"
                    variant="outlined"
                    class="mr-1"
                    :title="usage[skill.id]?.map((agent) => agent.name).join(', ')"
                    data-test="skill-usage"
                    >{{ usage[skill.id]?.length }}
                    {{ usage[skill.id]?.length === 1 ? 'agent' : 'agents' }}</v-chip
                  >
                  <v-chip v-if="skill.fileCount > 0" size="small"
                    >{{ skill.fileCount }} {{ skill.fileCount === 1 ? 'file' : 'files' }}</v-chip
                  >
                </template>
              </v-list-item>
            </v-list>
            <v-card-text v-if="skills.items.length === 0" class="text-medium-emphasis">
              No skills yet.
            </v-card-text>
          </v-card>
        </v-col>
        <v-col cols="12" md="8">
          <v-card v-if="editing" variant="outlined">
            <v-card-title class="text-subtitle-1">{{ title }}</v-card-title>
            <v-card-text>
              <v-form ref="form" :disabled="saving || loading" @submit.prevent="save">
                <v-text-field
                  v-model="draft.name"
                  label="Name"
                  hint="Directory name in the run workspace: .claude/skills/<name>/SKILL.md"
                  persistent-hint
                  :rules="nameRules"
                  class="mb-2"
                />
                <v-text-field
                  v-model="draft.description"
                  label="Description"
                  hint="Tells the agent when to use this skill"
                  persistent-hint
                  :rules="descriptionRules"
                  class="mb-2"
                />
                <v-textarea
                  v-model="draft.body"
                  label="Instructions (Markdown, without frontmatter)"
                  rows="14"
                  auto-grow
                  class="skill-body"
                />
                <v-alert
                  v-if="selected?.source"
                  type="info"
                  variant="tonal"
                  density="compact"
                  class="mb-2"
                  data-test="skill-provenance"
                >
                  Imported from {{ providerLabel(selected.source.provider) }}:
                  <a :href="selected.source.url" target="_blank" rel="noopener noreferrer">{{
                    selected.source.slug
                  }}</a>
                  on {{ new Date(selected.source.importedAt).toLocaleString() }}. Third-party text:
                  review it before assigning the skill to an agent.
                </v-alert>
                <div v-if="selected && selected.files.length > 0" class="text-caption mb-2">
                  Supporting files (managed via API):
                  <code v-for="file in selected.files" :key="file.path" class="mr-2">
                    {{ file.path }}
                  </code>
                </div>
                <div v-if="selected" class="text-caption mb-2" data-test="skill-used-by">
                  <template v-if="usedBy.length > 0">
                    Used by
                    <template v-for="(agent, index) in usedBy" :key="agent.id">
                      <router-link :to="{ name: 'agent', params: { agentId: agent.id } }">{{
                        agent.name
                      }}</router-link
                      ><span v-if="index < usedBy.length - 1">, </span>
                    </template>
                  </template>
                  <span v-else-if="usageKnown" class="text-medium-emphasis"
                    >Not assigned to any agent.</span
                  >
                  <span v-else-if="usageKnown === false" class="text-warning">
                    Could not load which agents use this skill.
                    <a href="#" @click.prevent="loadUsage">Retry</a>
                  </span>
                </div>
                <div class="d-flex ga-2">
                  <v-btn
                    type="submit"
                    color="primary"
                    :loading="saving"
                    :disabled="saving || loading"
                    >Save</v-btn
                  >
                  <v-btn variant="text" :disabled="saving" @click="close">Close</v-btn>
                  <v-spacer />
                  <v-btn
                    v-if="selected"
                    color="error"
                    variant="text"
                    :disabled="saving || loading"
                    @click="confirmDelete = true"
                  >
                    Delete
                  </v-btn>
                </div>
              </v-form>
            </v-card-text>
          </v-card>
          <div v-else class="text-medium-emphasis pa-4">
            Select a skill to edit it, or create a new one.
          </div>
        </v-col>
      </v-row>
    </template>
    <v-dialog v-model="confirmDelete" max-width="420">
      <v-card :title="`Delete ${selected?.name ?? ''}?`">
        <v-card-text>
          <template v-if="usedBy.length > 0">
            Still assigned to {{ usedBy.map((agent) => agent.name).join(', ') }}; remove it from
            those agents first.
          </template>
          <template v-else>Skills that are still assigned to agents cannot be deleted.</template>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="confirmDelete = false">Cancel</v-btn>
          <v-btn color="error" @click="remove">Delete</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<style scoped>
.skill-body :deep(textarea) {
  font-family: ui-monospace, monospace;
}
</style>
