<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import ConnectionsPanel from '../../components/connections/ConnectionsPanel.vue';
import { useAuthStore } from '../../stores/auth';
import { useProjectsStore } from '../../stores/projects';

const auth = useAuthStore();
const projects = useProjectsStore();
const projectOptions = computed(() =>
  projects.items.map((project) => ({ id: project.id, key: project.key, name: project.name })),
);

const projectsError = ref('');

onMounted(() =>
  projects.load().catch((cause: unknown) => {
    projectsError.value = `Projects could not be loaded, so project connections cannot be created here: ${cause instanceof Error ? cause.message : String(cause)}`;
  }),
);
</script>

<template>
  <v-container fluid class="pa-3">
    <v-card>
      <v-card-title>Connections</v-card-title>
      <v-card-text>
        <v-alert v-if="projectsError" type="warning" variant="tonal" density="compact" class="mb-2">
          {{ projectsError }}
        </v-alert>
        <ConnectionsPanel
          :project-id="null"
          :is-owner="auth.me?.role === 'owner'"
          :projects="projectOptions"
        />
      </v-card-text>
    </v-card>
  </v-container>
</template>
