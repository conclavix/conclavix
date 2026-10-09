import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { idSchema } from '@conclavix/core';
import { parse } from '../../validation.js';
import type { AuditFilter, AuditLog } from './audit.js';

const actionSchema = z.string().regex(/^[a-z0-9_.]{1,64}$/, 'must be an audit action name');

const querySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: idSchema.optional(),
  /** One or more exact action names, comma separated. */
  action: z
    .string()
    .transform((value) => value.split(',').filter(Boolean))
    .pipe(z.array(actionSchema).min(1).max(50))
    .optional(),
  /** A user id, or `board` / `system` / `agent` for the non-user actors. */
  actor: z.union([idSchema, z.enum(['board', 'system', 'agent'])]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/** Read the security audit log, newest first, paged by id and optionally filtered. */
export function registerAuditRoutes(app: FastifyInstance, audit: AuditLog): void {
  app.get('/api/audit', async (request) => {
    const query = parse(querySchema, request.query);
    const filter: AuditFilter = {
      ...(query.action ? { actions: query.action } : {}),
      ...(query.actor ? { actor: query.actor } : {}),
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
    };
    const docs = await audit.list(
      query.limit,
      query.before ? new ObjectId(query.before) : undefined,
      filter,
    );
    const items = docs.map(({ _id, ...rest }) => ({ id: _id.toHexString(), ...rest }));
    return { items, nextCursor: items.length === query.limit ? (items.at(-1)?.id ?? null) : null };
  });
}
