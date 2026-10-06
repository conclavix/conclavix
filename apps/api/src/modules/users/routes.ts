import type { FastifyInstance } from 'fastify';
import { createUserSchema, resetPasswordSchema, updateUserSchema } from '@conclavix/core';
import { parse } from '../../validation.js';
import { requirePrincipal } from '../auth/principal.js';
import type { StreamConnections } from '../stream/connections.js';
import type { UserService } from './service.js';

interface IdParams {
  id: string;
}

/** Register user administration routes; capabilities come from the permission map. */
export function registerUserRoutes(
  app: FastifyInstance,
  users: UserService,
  streams: StreamConnections,
): void {
  /** After a change that can take access away, end the user's event streams that lost it. */
  const recheck = async <T>(id: string, result: T): Promise<T> => {
    await streams.recheckUser(id);
    return result;
  };

  app.get('/api/users', async () => ({ items: await users.list() }));

  app.get('/api/users/names', async () => ({ items: await users.names() }));

  app.get<{ Params: IdParams }>('/api/users/:id', async (request) => users.get(request.params.id));

  app.post('/api/users', async (request, reply) => {
    const result = await users.create(
      parse(createUserSchema, request.body),
      requirePrincipal(request),
    );
    return reply.status(201).send(result);
  });

  app.patch<{ Params: IdParams }>('/api/users/:id', async (request) =>
    recheck(
      request.params.id,
      await users.update(
        request.params.id,
        parse(updateUserSchema, request.body),
        requirePrincipal(request),
      ),
    ),
  );

  app.post<{ Params: IdParams }>('/api/users/:id/ban', async (request) =>
    recheck(
      request.params.id,
      await users.setBanned(request.params.id, true, requirePrincipal(request)),
    ),
  );

  app.post<{ Params: IdParams }>('/api/users/:id/unban', async (request) =>
    users.setBanned(request.params.id, false, requirePrincipal(request)),
  );

  app.post<{ Params: IdParams }>('/api/users/:id/reset-password', async (request) =>
    recheck(
      request.params.id,
      await users.resetPassword(
        request.params.id,
        parse(resetPasswordSchema, request.body ?? {}).password,
        requirePrincipal(request),
      ),
    ),
  );

  app.post<{ Params: IdParams }>('/api/users/:id/reset-2fa', async (request) =>
    recheck(request.params.id, await users.resetMfa(request.params.id, requirePrincipal(request))),
  );

  app.delete<{ Params: IdParams }>('/api/users/:id', async (request, reply) => {
    await users.remove(request.params.id, requirePrincipal(request));
    await streams.recheckUser(request.params.id);
    return reply.status(204).send();
  });
}
