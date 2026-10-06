import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api, apiValidated } from '../api/client';
import { skillSchema, skillListSchema } from '../api/skills';
import type { Skill, SkillDraft, SkillSummary } from '../api/types';

export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The skill library: summaries for the list, full skills loaded on demand for editing. */
export const useSkillsStore = defineStore('skills', () => {
  const items = ref<SkillSummary[]>([]);

  const refreshError = ref('');
  let loadVersion = 0;

  async function load(): Promise<void> {
    const version = ++loadVersion;
    const result = await apiValidated(skillListSchema, '/skills');
    if (version === loadVersion) items.value = result.items;
  }

  /** Refresh failures are visible without rejecting an already completed mutation. */
  async function refresh(): Promise<void> {
    const version = loadVersion + 1;
    refreshError.value = '';
    try {
      await load();
    } catch {
      if (version === loadVersion) {
        refreshError.value = 'Could not refresh the skill list. Try refreshing again.';
      }
    }
  }

  function get(id: string): Promise<Skill> {
    return apiValidated(skillSchema, `/skills/${encodeURIComponent(id)}`);
  }

  /** Create a skill, or update the given one; supporting files are left untouched on update. */
  async function save(draft: SkillDraft, id?: string): Promise<Skill> {
    const skill = await apiValidated(
      skillSchema,
      id ? `/skills/${encodeURIComponent(id)}` : '/skills',
      {
        method: id ? 'PATCH' : 'POST',
        body: JSON.stringify(draft),
      },
    );
    const summary = {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      updatedAt: skill.updatedAt,
      fileCount: skill.files.length,
      sourceProvider: skill.source?.provider ?? null,
    };
    items.value = [...items.value.filter((item) => item.id !== skill.id), summary];
    await refresh();
    return skill;
  }

  async function remove(id: string): Promise<void> {
    await api(`/skills/${encodeURIComponent(id)}`, { method: 'DELETE' });
    items.value = items.value.filter((item) => item.id !== id);
    await refresh();
  }

  return { items, refreshError, load, refresh, get, save, remove };
});
