import type { FastifyInstance } from 'fastify';
import { createProjectSchema, updateProjectSchema } from '@conclavix/core';
import { parse, toObjectId } from '../../validation.js';
import type { Database } from '../../db.js';
import type { ProjectPlanner } from '../org/planning.js';
import type { Workspace } from '../workspace/service.js';
import type { ProjectRepository } from './repository.js';

interface IdParams {
  id: string;
}

/**
 * Register project list, read, create, and update routes with body and ID validation.
 * Creating a project also creates a planning issue for the lead unless `autoPlan` is false;
 * the response carries the outcome in `planning`. With a workspace, the project's git repository
 * is created right after; a failure there is logged and the repository is created on first access.
 */
export function registerProjectRoutes(
  app: FastifyInstance,
  projects: ProjectRepository,
  planner: ProjectPlanner,
  database: Database,
  workspace: Workspace | null = null,
): void {
  app.get('/api/projects', async () => ({ items: await projects.list() }));

  app.get<{ Params: IdParams }>('/api/projects/:id', async (request) =>
    projects.get(toObjectId(request.params.id, 'Project')),
  );

  app.post('/api/projects', async (request, reply) => {
    const input = parse(createProjectSchema, request.body);
    const result = await database.inTransaction(async (session) => {
      const project = await projects.create(input, session);
      const planning = await planner.plan(project, input.autoPlan, session);
      return { ...project, planning };
    });
    if (workspace) {
      try {
        await workspace.ensureRepo(result.id);
      } catch (error) {
        request.log.error(
          { err: error, projectId: result.id },
          'project repository not created; it is created on first access',
        );
      }
    }
    return reply.status(201).send(result);
  });

  app.patch<{ Params: IdParams }>('/api/projects/:id', async (request) =>
    projects.update(
      toObjectId(request.params.id, 'Project'),
      parse(updateProjectSchema, request.body),
    ),
  );
}
