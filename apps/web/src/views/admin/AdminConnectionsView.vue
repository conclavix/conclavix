<script setup lang="ts">
import { computed, onMounted } from 'vue';
import ConnectionsPanel from '../../components/connections/ConnectionsPanel.vue';
import { useAuthStore } from '../../stores/auth';
import { useProjectsStore } from '../../stores/projects';

const auth = useAuthStore();
const projects = useProjectsStore();
const projectOptions = computed(() =>
  projects.items.map((project) => ({ id: project.id, key: project.key, name: project.name })),
);

onMounted(() => void projects.load().catch(() => undefined));
</script>

<template>
  <v-container fluid class="pa-3">
    <v-card>
      <v-card-title>Connections</v-card-title>
      <v-card-text>
        <ConnectionsPanel
          :project-id="null"
          :is-owner="auth.me?.role === 'owner'"
          :projects="projectOptions"
        />
      </v-card-text>
    </v-card>
  </v-container>
</template>
