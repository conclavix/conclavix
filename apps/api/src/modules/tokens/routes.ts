import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { createApiTokenSchema } from '@conclavix/core';
import type { Database } from '../../db.js';
import { AppError, notFound } from '../../errors.js';
import { parse, toObjectId } from '../../validation.js';
import type { AuditLog } from '../audit/audit.js';
import { requireUser } from '../auth/principal.js';
import type { StreamConnections } from '../stream/connections.js';
import type { ApiTokenRepository } from './repository.js';

/**
 * Personal API tokens of the signed-in user; creating one needs a session, not a token. Creating
 * and revoking commit together with their audit entry, so a failed audit write fails the change.
 */
export function registerTokenRoutes(
  app: FastifyInstance,
  database: Database,
  tokens: ApiTokenRepository,
  audit: AuditLog,
  streams: StreamConnections,
): void {
  app.get('/api/me/tokens', async (request) => ({
    items: await tokens.list(new ObjectId(requireUser(request).userId)),
  }));

  app.post('/api/me/tokens', async (request, reply) => {
    const user = requireUser(request);
    if (user.via !== 'session') {
      throw new AppError(403, 'session_required', 'API tokens can only be created when signed in');
    }
    const input = parse(createApiTokenSchema, request.body);
    const created = await database.inTransaction(async (session) => {
      const result = await tokens.create(new ObjectId(user.userId), input, session);
      await audit.write(
        {
          action: 'token.created',
          actor: { type: 'user', userId: user.userId },
          targetUserId: user.userId,
          details: {
            tokenId: result.summary.id,
            name: result.summary.name,
            expiresAt: result.summary.expiresAt,
          },
        },
        session,
      );
      return result;
    });
    return reply.status(201).send({ ...created.summary, token: created.token });
  });

  app.delete<{ Params: { id: string } }>('/api/me/tokens/:id', async (request, reply) => {
    const user = requireUser(request);
    const tokenId = toObjectId(request.params.id, 'Token');
    await database.inTransaction(async (session) => {
      const revoked = await tokens.revoke(new ObjectId(user.userId), tokenId, session);
      if (!revoked) throw notFound('Token');
      await audit.write(
        {
          action: 'token.revoked',
          actor: { type: 'user', userId: user.userId },
          targetUserId: user.userId,
          details: { tokenId: revoked.id, name: revoked.name },
        },
        session,
      );
    });
    // A stream opened with the revoked token must not keep receiving events.
    await streams.recheckUser(user.userId);
    return reply.status(204).send();
  });
}
