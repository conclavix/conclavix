import type { FastifyInstance } from 'fastify';
import { createIssueSchema, listIssuesQuerySchema, updateIssueSchema } from '@conclavix/core';
import { parse } from '../../validation.js';
import type { IssueRepository } from './repository.js';

interface RefParams {
  ref: string;
}

/** Register the board API routes for issues; `:ref` accepts an id or a key like CVX-12. */
export function registerIssueRoutes(app: FastifyInstance, issues: IssueRepository): void {
  app.get('/api/issues', async (request) =>
    issues.list(parse(listIssuesQuerySchema, request.query)),
  );

  app.get<{ Params: RefParams }>('/api/issues/:ref', async (request) =>
    issues.get(request.params.ref),
  );

  app.post('/api/issues', async (request, reply) => {
    const issue = await issues.create(parse(createIssueSchema, request.body));
    return reply.status(201).send(issue);
  });

  app.patch<{ Params: RefParams }>('/api/issues/:ref', async (request) =>
    issues.update(request.params.ref, parse(updateIssueSchema, request.body)),
  );
}
