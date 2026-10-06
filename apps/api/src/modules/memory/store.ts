import type { Memory, MemoryScope } from '@conclavix/core';

/** One readable or writable bucket: global, a project's, or an agent's own memory. */
export type MemoryBucket =
  | { scope: 'global' }
  | { scope: 'project'; projectId: string }
  | { scope: 'agent'; agentId: string };

export interface MemoryWrite {
  bucket: MemoryBucket;
  title: string;
  body: string;
  tags: string[];
  author: Memory['author'];
}

export interface MemoryQuery {
  /** Restrict to these buckets; 'any' is for the board, which may see everything. */
  buckets: MemoryBucket[] | 'any';
  /** Optional further narrowing by scope, used by the board's list filter. */
  scope?: MemoryScope;
  text: string;
  limit: number;
}

/**
 * Where memories live. Conclavix decides who may read and write which bucket; a store only
 * persists and searches. Saving a title that already exists in the bucket replaces that entry,
 * so lessons are kept up to date instead of piling up.
 */
export interface MemoryStore {
  search(query: MemoryQuery): Promise<Memory[]>;
  save(write: MemoryWrite): Promise<{ memory: Memory; created: boolean }>;
  get(id: string): Promise<Memory | null>;
  update(
    id: string,
    changes: Partial<Pick<Memory, 'title' | 'body' | 'tags'>>,
  ): Promise<Memory | null>;
  remove(id: string): Promise<boolean>;
}

export const bucketOf = (memory: Pick<Memory, 'scope' | 'projectId' | 'agentId'>): MemoryBucket => {
  if (memory.scope === 'project' && memory.projectId) {
    return { scope: 'project', projectId: memory.projectId };
  }
  if (memory.scope === 'agent' && memory.agentId) {
    return { scope: 'agent', agentId: memory.agentId };
  }
  return { scope: 'global' };
};

export const scopeFields = (
  bucket: MemoryBucket,
): { scope: MemoryScope; projectId: string | null; agentId: string | null } => ({
  scope: bucket.scope,
  projectId: bucket.scope === 'project' ? bucket.projectId : null,
  agentId: bucket.scope === 'agent' ? bucket.agentId : null,
});
