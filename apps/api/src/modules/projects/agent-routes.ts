import type { FastifyInstance } from 'fastify';
import { setProjectAgentSchema } from '@conclavix/core';
import { parse, toObjectId } from '../../validation.js';
import { actorOf, requirePrincipal } from '../auth/principal.js';
import type { ProjectAgentsService } from './project-agents.js';

interface ProjectParams {
  id: string;
}

interface ProjectAgentParams extends ProjectParams {
  agentId: string;
}

/** Per-project agent access: read by everyone, changed by roles that manage agents. */
export function registerProjectAgentRoutes(
  app: FastifyInstance,
  service: ProjectAgentsService,
): void {
  app.get<{ Params: ProjectParams }>('/api/projects/:id/agents', async (request) => ({
    items: await service.list(toObjectId(request.params.id, 'Project')),
  }));

  app.put<{ Params: ProjectAgentParams }>('/api/projects/:id/agents/:agentId', async (request) => {
    const principal = requirePrincipal(request);
    const { enabled } = parse(setProjectAgentSchema, request.body);
    return service.set(
      toObjectId(request.params.id, 'Project'),
      toObjectId(request.params.agentId, 'Agent'),
      enabled,
      { actor: actorOf(principal), ip: request.ip },
    );
  });
}
