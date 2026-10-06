import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '../api/client';
import type { Page, Project } from '../api/types';

export interface ProjectInput {
  key?: string;
  name?: string;
  description?: string;
  status?: Project['status'];
}

export const useProjectsStore = defineStore('projects', () => {
  const items = ref<Project[]>([]);
  const loaded = ref(false);

  const byId = computed(() => Object.fromEntries(items.value.map((p) => [p.id, p])));
  const active = computed(() => items.value.filter((p) => p.status === 'active'));

  async function load(): Promise<void> {
    items.value = (await api<Page<Project>>('/projects')).items;
    loaded.value = true;
  }

  async function ensureLoaded(): Promise<void> {
    if (!loaded.value) await load();
  }

  function upsert(project: Project): Project {
    const index = items.value.findIndex((p) => p.id === project.id);
    items.value =
      index === -1
        ? [...items.value, project]
        : items.value.map((p) => (p.id === project.id ? project : p));
    return project;
  }

  async function create(input: ProjectInput): Promise<Project> {
    return upsert(await api<Project>('/projects', { method: 'POST', body: JSON.stringify(input) }));
  }

  async function update(id: string, input: ProjectInput): Promise<Project> {
    return upsert(
      await api<Project>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
    );
  }

  return { items, loaded, byId, active, load, ensureLoaded, create, update };
});
