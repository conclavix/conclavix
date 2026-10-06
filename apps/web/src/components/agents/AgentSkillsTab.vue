<script setup lang="ts">
import { mdiClose, mdiOpenInNew, mdiRefresh } from '@mdi/js';
import { computed, onMounted, ref } from 'vue';
import { patchAgent } from '../../agents/api';
import {
  MAX_AGENT_SKILLS,
  addSkill,
  assignedSkills,
  availableSkills,
  removeSkill,
  sameSkills,
  skillsErrorText,
  skillsPatch,
} from '../../agents/skills';
import type { AgentDetail } from '../../api/types';
import { useSkillsStore } from '../../stores/skills';

/** The draft list of assigned skill IDs lives in the parent so it can guard unsaved changes. */
const draft = defineModel<string[]>({ required: true });
const props = defineProps<{ agent: AgentDetail; readOnly: boolean }>();
const emit = defineEmits<{ updated: [agent: AgentDetail] }>();

const skills = useSkillsStore();
const libraryError = ref('');
const libraryLoading = ref(false);
const libraryLoaded = ref(false);
const error = ref('');
const saving = ref(false);
const saved = ref(false);
const picked = ref<string | null>(null);

const savedIds = computed(() => props.agent.skillIds ?? []);
const dirty = computed(() => !sameSkills(savedIds.value, draft.value));
const rows = computed(() => assignedSkills(draft.value, skills.items, libraryLoaded.value));
const options = computed(() => availableSkills(draft.value, skills.items));
const full = computed(() => draft.value.length >= MAX_AGENT_SKILLS);

async function loadLibrary(): Promise<void> {
  libraryLoading.value = true;
  libraryError.value = '';
  try {
    await skills.load();
    libraryLoaded.value = true;
  } catch (cause) {
    libraryError.value = `Could not load the skill library: ${skillsErrorText(cause, [])}`;
  } finally {
    libraryLoading.value = false;
  }
}
onMounted(loadLibrary);

function add(id: string | null): void {
  if (id && !props.readOnly && !full.value) draft.value = addSkill(draft.value, id);
  picked.value = null;
}

function remove(id: string): void {
  if (!props.readOnly) draft.value = removeSkill(draft.value, id);
}

async function save(): Promise<void> {
  const patch = skillsPatch(savedIds.value, draft.value);
  if (!patch || props.readOnly || saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    emit('updated', await patchAgent(props.agent.id, patch));
    saved.value = true;
  } catch (cause) {
    error.value = skillsErrorText(cause, skills.items);
  } finally {
    saving.value = false;
  }
}

function discard(): void {
  draft.value = [...savedIds.value];
  error.value = '';
}
</script>

<template>
  <div data-test="agent-skills">
    <p class="text-body-2 text-medium-emphasis mb-2">
      Skills are mounted into every run of this agent as
      <code>.claude/skills/&lt;name&gt;/SKILL.md</code>. Manage the library under
      <router-link :to="{ name: 'skills' }">Skills</router-link>.
    </p>
    <v-alert
      v-if="readOnly"
      type="info"
      variant="tonal"
      density="compact"
      class="mb-2"
      data-test="skills-read-only"
    >
      Only admins and the owner can change the skills of an agent.
    </v-alert>
    <v-alert v-if="libraryError" type="warning" variant="tonal" class="mb-2">
      {{ libraryError }}
      <template #append>
        <v-btn :icon="mdiRefresh" variant="text" aria-label="Retry" @click="loadLibrary" />
      </template>
    </v-alert>
    <v-autocomplete
      v-if="!readOnly"
      v-model="picked"
      :items="options"
      item-title="name"
      item-value="id"
      label="Add a skill"
      :hint="
        full
          ? `An agent can have at most ${MAX_AGENT_SKILLS} skills.`
          : 'Search by name or description'
      "
      persistent-hint
      :disabled="full || saving"
      :loading="libraryLoading"
      :filter-keys="['title', 'raw.description']"
      no-data-text="No more skills in the library"
      clearable
      class="mb-3"
      data-test="skill-picker"
      @update:model-value="add"
    >
      <template #item="{ props: itemProps, item }">
        <v-list-item v-bind="itemProps" :subtitle="item.description" />
      </template>
    </v-autocomplete>
    <v-list v-if="rows.length > 0" density="comfortable" border rounded class="mb-3">
      <v-list-item
        v-for="skill in rows"
        :key="skill.id"
        :subtitle="skill.description"
        data-test="assigned-skill"
      >
        <template #title>
          <router-link
            v-if="skill.state === 'known'"
            :to="{ name: 'skills', query: { skill: skill.id } }"
            class="skill-link"
          >
            {{ skill.name }}
            <v-icon :icon="mdiOpenInNew" size="x-small" />
          </router-link>
          <span v-else :class="{ 'text-error': skill.state === 'missing' }">{{ skill.name }}</span>
        </template>
        <template v-if="!readOnly" #append>
          <v-btn
            :icon="mdiClose"
            variant="text"
            size="small"
            :aria-label="`Remove ${skill.name}`"
            :disabled="saving"
            data-test="remove-skill"
            @click="remove(skill.id)"
          />
        </template>
      </v-list-item>
    </v-list>
    <div v-else class="text-medium-emphasis pa-4" data-test="no-skills">No skills assigned.</div>
    <v-alert v-if="error" type="error" variant="tonal" class="my-2" data-test="skills-error">
      {{ error }}
    </v-alert>
    <div v-if="!readOnly" class="d-flex align-center ga-2">
      <v-btn
        color="primary"
        variant="flat"
        :disabled="!dirty"
        :loading="saving"
        data-test="save-skills"
        @click="save"
      >
        Save skills
      </v-btn>
      <v-btn variant="text" :disabled="!dirty || saving" @click="discard">Discard</v-btn>
      <span v-if="dirty" class="text-caption text-warning">Unsaved changes</span>
    </div>
    <v-snackbar v-model="saved" color="success" timeout="2000">Skills saved</v-snackbar>
  </div>
</template>

<style scoped>
.skill-link {
  color: inherit;
}
</style>
