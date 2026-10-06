import { z } from 'zod';
import { idSchema } from './ids.js';

export const authorSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('board') }),
  z.strictObject({ type: z.literal('user'), userId: idSchema }),
  z.strictObject({ type: z.literal('system') }),
  z.strictObject({ type: z.literal('agent'), agentId: idSchema }),
]);

export const createCommentSchema = z.strictObject({
  body: z.string().trim().min(1).max(20000),
});

export const pageQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  after: idSchema.optional(),
});

export const documentKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,47}$/, 'must be 1-48 lowercase letters, digits or dashes');

export const writeDocumentSchema = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().max(200000),
  baseRevision: z.int().min(1).optional(),
});

export type Author = z.infer<typeof authorSchema>;
export type CreateCommentInput = z.infer<typeof createCommentSchema>;
export type PageQuery = z.infer<typeof pageQuerySchema>;
export type WriteDocumentInput = z.infer<typeof writeDocumentSchema>;

export interface Comment {
  id: string;
  issueId: string;
  author: Author;
  body: string;
  createdAt: Date;
}

export interface DocumentSummary {
  key: string;
  issueId: string;
  title: string;
  revision: number;
  updatedAt: Date;
}

export interface DocumentRevision extends DocumentSummary {
  body: string;
  author: Author;
  createdAt: Date;
}
