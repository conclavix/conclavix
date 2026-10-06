import { z } from 'zod';
import { api } from './client';

export type MemoryScope = 'global' | 'project' | 'agent';

const MemorySchema = z.object({
  id: z.string(),
  scope: z.enum(['global', 'project', 'agent']),
  projectId: z.string().nullable(),
  agentId: z.string().nullable(),
  title: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  author: z.discriminatedUnion('type', [
    z.object({ type: z.literal('board') }),
    z.object({ type: z.literal('user'), userId: z.string() }),
    z.object({ type: z.literal('agent'), agentId: z.string() }),
  ]),
  revision: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const MemoryPageSchema = z.object({ items: z.array(MemorySchema) });
export type Memory = z.infer<typeof MemorySchema>;

/** Which bucket a panel shows; project and agent buckets need their owner id. */
export type MemoryBucket =
  | { scope: 'global' }
  | { scope: 'project'; projectId: string }
  | { scope: 'agent'; agentId: string };

export interface MemoryFields {
  title: string;
  body: string;
  tags: string[];
}

export const MEMORY_PAGE = 50;

export function listQuery(bucket: MemoryBucket, q: string, limit = MEMORY_PAGE): string {
  const params = new URLSearchParams({ scope: bucket.scope, limit: String(limit) });
  if (bucket.scope === 'project') params.set('projectId', bucket.projectId);
  if (bucket.scope === 'agent') params.set('agentId', bucket.agentId);
  if (q.trim()) params.set('q', q.trim());
  return params.toString();
}

export const memoryApi = {
  list: async (bucket: MemoryBucket, q: string): Promise<Memory[]> =>
    MemoryPageSchema.parse(await api<unknown>(`/memories?${listQuery(bucket, q)}`)).items,
  get: async (id: string): Promise<Memory> =>
    MemorySchema.parse(await api<unknown>(`/memories/${encodeURIComponent(id)}`)),
  create: async (bucket: MemoryBucket, fields: MemoryFields): Promise<Memory> =>
    MemorySchema.parse(
      await api<unknown>('/memories', {
        method: 'POST',
        body: JSON.stringify({ ...bucket, ...fields }),
      }),
    ),
  update: async (id: string, fields: Partial<MemoryFields>): Promise<Memory> =>
    MemorySchema.parse(
      await api<unknown>(`/memories/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(fields),
      }),
    ),
  remove: async (id: string): Promise<void> => {
    await api<unknown>(`/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
};
