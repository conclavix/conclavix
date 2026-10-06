import { z } from 'zod';
import { idSchema } from './ids.js';

export const memoryScopeSchema = z.enum(['global', 'project', 'agent']);

const titleSchema = z.string().trim().min(1).max(200);
const bodySchema = z.string().trim().min(1).max(20000);
const tagsSchema = z.array(z.string().trim().min(1).max(40)).max(20);

/** What the board may write: any scope; project and agent scopes need their owner. */
export const createMemorySchema = z
  .strictObject({
    scope: memoryScopeSchema,
    projectId: idSchema.nullable().default(null),
    agentId: idSchema.nullable().default(null),
    title: titleSchema,
    body: bodySchema,
    tags: tagsSchema.default([]),
  })
  .refine((value) => value.scope !== 'project' || value.projectId !== null, {
    message: 'project memories need a projectId',
    path: ['projectId'],
  })
  .refine((value) => value.scope !== 'agent' || value.agentId !== null, {
    message: 'agent memories need an agentId',
    path: ['agentId'],
  });

export const updateMemorySchema = z
  .strictObject({ title: titleSchema, body: bodySchema, tags: tagsSchema })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');

export const listMemoriesQuerySchema = z.strictObject({
  scope: memoryScopeSchema.optional(),
  projectId: idSchema.optional(),
  agentId: idSchema.optional(),
  q: z.string().trim().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** What an agent may write: never global; the owner is the run's project or agent. */
export const agentMemorySaveSchema = z.strictObject({
  scope: z.enum(['project', 'agent']),
  title: titleSchema,
  body: bodySchema,
  tags: tagsSchema.default([]),
});

export const agentMemorySearchSchema = z.strictObject({
  query: z.string().trim().max(500).default(''),
  scope: z.enum(['global', 'project', 'agent', 'all']).default('all'),
  limit: z.int().min(1).max(20).default(8),
});

export type MemoryAuthor =
  { type: 'board' } | { type: 'user'; userId: string } | { type: 'agent'; agentId: string };
export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export type CreateMemoryInput = z.infer<typeof createMemorySchema>;
export type UpdateMemoryInput = z.infer<typeof updateMemorySchema>;
export type ListMemoriesQuery = z.infer<typeof listMemoriesQuerySchema>;

export interface Memory {
  id: string;
  scope: MemoryScope;
  projectId: string | null;
  agentId: string | null;
  title: string;
  body: string;
  tags: string[];
  author: MemoryAuthor;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}
