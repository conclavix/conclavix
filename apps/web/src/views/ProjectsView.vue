<script setup lang="ts">
import { mdiArchiveArrowDownOutline, mdiArchiveArrowUpOutline, mdiPencil, mdiPlus } from '@mdi/js';
import { computed, onMounted, ref } from 'vue';
import type { Project } from '../api/types';
import ProjectDialog from '../components/ProjectDialog.vue';
import StatusChip from '../components/StatusChip.vue';
import { describeError } from '../issues';
import { markdownToText } from '../markdown-rich';
import { useProjectsStore } from '../stores/projects';

const projects = useProjectsStore();
const dialog = ref(false);
const editing = ref<Project | null>(null);
const showArchived = ref(false);
const error = ref('');

const visible = computed(() =>
  projects.items
    .filter((p) => showArchived.value || p.status === 'active')
    .sort((a, b) => a.key.localeCompare(b.key)),
);

/** Plain-text excerpts, so Markdown descriptions read as text instead of raw syntax. */
const excerpts = computed(
  () => new Map(visible.value.map((p) => [p.id, markdownToText(p.description ?? '')])),
);

onMounted(() => projects.load().catch((cause) => (error.value = describeError(cause))));

function edit(project: Project | null): void {
  editing.value = project;
  dialog.value = true;
}

async function toggleArchive(project: Project): Promise<void> {
  error.value = '';
  try {
    await projects.update(project.id, {
      status: project.status === 'active' ? 'archived' : 'active',
    });
  } catch (cause) {
    error.value = describeError(cause);
  }
}
</script>

<template>
  <v-container class="pa-3" style="max-width: 1100px">
    <div class="d-flex align-center ga-2 mb-3">
      <span class="text-h6">Projects</span>
      <v-spacer />
      <v-switch v-model="showArchived" label="Show archived" hide-details density="compact" />
      <v-btn color="primary" :prepend-icon="mdiPlus" @click="edit(null)">New project</v-btn>
    </div>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-2">{{ error }}</v-alert>
    <v-card>
      <v-list lines="two">
        <v-list-item
          v-for="project in visible"
          :key="project.id"
          :to="{ name: 'project', params: { projectKey: project.key } }"
          :data-project="project.key"
        >
          <template #title>
            <span class="font-weight-medium">{{ project.key }}</span> · {{ project.name }}
            <StatusChip :status="project.status" class="ml-2" />
          </template>
          <div
            class="project-excerpt text-body-2 text-medium-emphasis mt-1"
            data-test="project-excerpt"
          >
            {{ excerpts.get(project.id) || 'No description' }}
          </div>
          <template #append>
            <v-btn
              :icon="mdiPencil"
              variant="text"
              :aria-label="`Edit ${project.key}`"
              @click.prevent.stop="edit(project)"
            />
            <v-btn
              :icon="
                project.status === 'active' ? mdiArchiveArrowDownOutline : mdiArchiveArrowUpOutline
              "
              variant="text"
              :aria-label="`${project.status === 'active' ? 'Archive' : 'Unarchive'} ${project.key}`"
              @click.prevent.stop="toggleArchive(project)"
            />
          </template>
        </v-list-item>
        <v-list-item v-if="projects.loaded && visible.length === 0" subtitle="No projects yet" />
      </v-list>
    </v-card>
    <ProjectDialog v-model="dialog" :project="editing" />
  </v-container>
</template>

<style scoped>
.project-excerpt {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
  white-space: pre-line;
  overflow-wrap: anywhere;
}
</style>
