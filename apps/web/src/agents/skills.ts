import { ApiError } from '../api/client';
import type { Agent, SkillSummary } from '../api/types';
import { describeError } from '../issues';

/** The API caps an agent's skill list at this many entries (skillIdsSchema in @conclavix/core). */
export const MAX_AGENT_SKILLS = 50;

/** Roles holding the `agents` capability, which changing agents and the skill library needs. */
const AGENT_EDITOR_ROLES: ReadonlySet<string> = new Set(['owner', 'admin']);

/** True when the signed-in role may change agents and skills; unknown roles are read-only. */
export const canEditAgents = (role: string | null | undefined): boolean =>
  !!role && AGENT_EDITOR_ROLES.has(role);

/** Roles holding the `work` capability, which writing memories needs; viewers only read. */
const MEMORY_WRITER_ROLES: ReadonlySet<string> = new Set(['owner', 'admin', 'member']);

export const canWriteMemories = (role: string | null | undefined): boolean =>
  !!role && MEMORY_WRITER_ROLES.has(role);

/** Append a skill once, keeping the existing order; unchanged when it is already assigned. */
export function addSkill(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? [...ids] : [...ids, id];
}

export function removeSkill(ids: readonly string[], id: string): string[] {
  return ids.filter((existing) => existing !== id);
}

/** True when both lists hold the same skills; the order carries no meaning for the runner. */
export function sameSkills(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/** The PATCH body for a changed assignment, or null when there is nothing to save. */
export function skillsPatch(
  saved: readonly string[],
  draft: readonly string[],
): { skillIds: string[] } | null {
  return sameSkills(saved, draft) ? null : { skillIds: [...new Set(draft)] };
}

export interface AssignedSkill {
  id: string;
  name: string;
  description: string;
  /**
   * known: listed in the library. missing: a loaded library lacks it, e.g. after a concurrent
   * delete. unresolved: the library is still loading or failed to load, so nothing is claimed.
   */
  state: 'known' | 'missing' | 'unresolved';
}

/** Resolve assigned IDs against the library, keeping unknown IDs visible so they can be removed. */
export function assignedSkills(
  ids: readonly string[],
  library: readonly SkillSummary[],
  libraryLoaded: boolean,
): AssignedSkill[] {
  const byId = new Map(library.map((skill) => [skill.id, skill]));
  return ids.map((id): AssignedSkill => {
    const skill = byId.get(id);
    if (skill) return { id, name: skill.name, description: skill.description, state: 'known' };
    return libraryLoaded
      ? { id, name: id, description: 'Not in the skill library', state: 'missing' }
      : { id, name: id, description: '', state: 'unresolved' };
  });
}

/** Library skills not yet assigned, sorted by name for the picker. */
export function availableSkills(
  ids: readonly string[],
  library: readonly SkillSummary[],
): SkillSummary[] {
  const taken = new Set(ids);
  return library
    .filter((skill) => !taken.has(skill.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** For each skill ID, the agents that have it assigned, sorted by agent name. */
export function skillUsage(
  agents: readonly Pick<Agent, 'id' | 'name' | 'skillIds'>[],
): Record<string, { id: string; name: string }[]> {
  const usage: Record<string, { id: string; name: string }[]> = {};
  for (const agent of [...agents].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const skillId of agent.skillIds ?? []) {
      (usage[skillId] ??= []).push({ id: agent.id, name: agent.name });
    }
  }
  return usage;
}

/** One readable line for a failed save, naming the skills the server did not recognise. */
export function skillsErrorText(cause: unknown, library: readonly SkillSummary[]): string {
  if (cause instanceof ApiError && cause.status === 422) {
    const missing = (cause.details as { missing?: unknown } | undefined)?.missing;
    if (Array.isArray(missing) && missing.length > 0) {
      const names = new Map(library.map((skill) => [skill.id, skill.name]));
      const list = missing.map((id) => names.get(String(id)) ?? String(id)).join(', ');
      return `${cause.message}: ${list}. Reload the skill library and remove them.`;
    }
  }
  if (cause instanceof ApiError && cause.status === 403) {
    return 'Your role may not change agents. Ask an admin or the owner.';
  }
  return describeError(cause);
}
