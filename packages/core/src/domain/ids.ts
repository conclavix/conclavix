import { z } from 'zod';

export const idSchema = z.string().regex(/^[a-f0-9]{24}$/, 'must be a 24-character hex id');

export const boardColumnIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, 'must be 1-40 lowercase letters, digits, _ or -');

export type Id = z.infer<typeof idSchema>;
