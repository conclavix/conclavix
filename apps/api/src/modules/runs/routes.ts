import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { listRunsQuerySchema, manualWakeSchema } from '@conclavix/core';
import { parse, toObjectId } from '../../validation.js';
import type { RunRepository } from './repository.js';

const eventsQuerySchema = z.strictObject({ after: z.coerce.number().int().min(0).default(0) });

interface IdParams {
  id: string;
}

/** Register the board API routes for runs and manual wakes. */
export function registerRunRoutes(app: FastifyInstance, runs: RunRepository): void {
  app.get('/api/runs', async (request) => runs.list(parse(listRunsQuerySchema, request.query)));

  app.get<{ Params: IdParams }>('/api/runs/:id', async (request) =>
    runs.get(toObjectId(request.params.id, 'Run')),
  );

  app.get<{ Params: IdParams; Querystring: { after?: string } }>(
    '/api/runs/:id/events',
    async (request) =>
      runs.events(
        toObjectId(request.params.id, 'Run'),
        parse(eventsQuerySchema, request.query).after,
      ),
  );

  app.post<{ Params: IdParams }>('/api/agents/:id/wake', async (request, reply) => {
    const { issueId } = parse(manualWakeSchema, request.body);
    const result = await runs.wake(toObjectId(request.params.id, 'Agent'), new ObjectId(issueId));
    return reply.status(202).send(result);
  });
}
