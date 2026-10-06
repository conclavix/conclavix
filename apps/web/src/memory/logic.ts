import type { Memory, MemoryBucket, MemoryFields, MemoryScope } from '../api/memory';

export const LIMITS = { title: 200, body: 20000, tags: 20, tag: 40 } as const;

/** One search result: Hindsight returns several extracted facts per memory, Mongo one hit. */
export interface MemoryHit {
  memory: Memory;
  excerpts: string[];
}

/** The bucket a panel shows, or null while a project or agent has not been picked yet. */
export function bucketFor(
  scope: MemoryScope,
  projectId?: string | null,
  agentId?: string | null,
): MemoryBucket | null {
  if (scope === 'project') return projectId ? { scope, projectId } : null;
  if (scope === 'agent') return agentId ? { scope, agentId } : null;
  return { scope: 'global' };
}

/** Tags from a comma separated input: trimmed, without empties or case-insensitive duplicates. */
export function parseTags(text: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of text.split(',')) {
    const tag = raw.trim();
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
  }
  return tags;
}

/** The first rule the API would reject the fields for, so the editor can say so up front. */
export function fieldsProblem(fields: MemoryFields): string | null {
  const title = fields.title.trim();
  const body = fields.body.trim();
  if (!title) return 'Title is required';
  if (title.length > LIMITS.title) return `Title must be at most ${LIMITS.title} characters`;
  if (!body) return 'Body is required';
  if (body.length > LIMITS.body) return `Body must be at most ${LIMITS.body} characters`;
  if (fields.tags.length > LIMITS.tags) return `At most ${LIMITS.tags} tags`;
  const long = fields.tags.find((tag) => tag.length > LIMITS.tag);
  if (long) return `Tag "${long.slice(0, 20)}..." is longer than ${LIMITS.tag} characters`;
  return null;
}

/** Only the fields that differ, so a PATCH does not rewrite what the user left alone. */
export function changedFields(before: Memory, after: MemoryFields): Partial<MemoryFields> {
  const changes: Partial<MemoryFields> = {};
  if (after.title.trim() !== before.title.trim()) changes.title = after.title.trim();
  if (after.body.trim() !== before.body.trim()) changes.body = after.body.trim();
  if (after.tags.join('\n') !== before.tags.join('\n')) changes.tags = after.tags;
  return changes;
}

/** Search hits grouped per memory in rank order, each keeping its distinct excerpts. */
export function groupHits(memories: Memory[]): MemoryHit[] {
  const byId = new Map<string, MemoryHit>();
  for (const memory of memories) {
    const hit = byId.get(memory.id);
    if (!hit) {
      byId.set(memory.id, { memory, excerpts: [memory.body] });
    } else if (!hit.excerpts.includes(memory.body)) {
      hit.excerpts.push(memory.body);
    }
  }
  return [...byId.values()];
}
