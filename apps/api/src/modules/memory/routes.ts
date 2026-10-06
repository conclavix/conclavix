import type { FastifyInstance } from 'fastify';
import { createMemorySchema, listMemoriesQuerySchema, updateMemorySchema } from '@conclavix/core';
import { parse } from '../../validation.js';
import { authorOf, requirePrincipal } from '../auth/principal.js';
import type { MemoryService } from './service.js';

interface IdParams {
  id: string;
}

/** Register the board API routes for memories. */
export function registerMemoryRoutes(app: FastifyInstance, memories: MemoryService): void {
  app.get('/api/memories', async (request) => ({
    items: await memories.list(parse(listMemoriesQuerySchema, request.query)),
  }));

  app.get<{ Params: IdParams }>('/api/memories/:id', async (request) =>
    memories.get(request.params.id),
  );

  app.post('/api/memories', async (request, reply) => {
    const { memory, created } = await memories.create(
      parse(createMemorySchema, request.body),
      authorOf(requirePrincipal(request)),
    );
    return reply.status(created ? 201 : 200).send(memory);
  });

  app.patch<{ Params: IdParams }>('/api/memories/:id', async (request) =>
    memories.update(request.params.id, parse(updateMemorySchema, request.body)),
  );

  app.delete<{ Params: IdParams }>('/api/memories/:id', async (request, reply) => {
    await memories.remove(request.params.id);
    return reply.status(204).send();
  });
}
