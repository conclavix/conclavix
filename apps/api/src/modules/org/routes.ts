import type { FastifyInstance } from 'fastify';
import {
  createAgentLinkSchema,
  setLayoutSchema,
  setLeadSchema,
  updateAgentLinkSchema,
} from '@conclavix/core';
import { parse, toObjectId } from '../../validation.js';
import type { OrgGraphRepository } from './graph.js';
import type { OrgRepository } from './repository.js';

interface IdParams {
  id: string;
}

/** Register the org routes: lead, agent graph, links and canvas layout. */
export function registerOrgRoutes(
  app: FastifyInstance,
  org: OrgRepository,
  graph: OrgGraphRepository,
): void {
  app.get('/api/org', async () => org.get());

  app.put('/api/org/lead', async (request) => {
    const { agentId } = parse(setLeadSchema, request.body);
    return org.setLead(toObjectId(agentId, 'Agent'));
  });

  app.put('/api/org/layout', async (request, reply) => {
    await graph.setLayout(parse(setLayoutSchema, request.body));
    return reply.status(204).send();
  });

  app.get('/api/org-graph', async () => graph.graph());

  app.post('/api/agent-links', async (request, reply) => {
    const link = await graph.createLink(parse(createAgentLinkSchema, request.body));
    return reply.status(201).send(link);
  });

  app.patch<{ Params: IdParams }>('/api/agent-links/:id', async (request) =>
    graph.updateLink(
      toObjectId(request.params.id, 'Link'),
      parse(updateAgentLinkSchema, request.body),
    ),
  );

  app.delete<{ Params: IdParams }>('/api/agent-links/:id', async (request, reply) => {
    await graph.removeLink(toObjectId(request.params.id, 'Link'));
    return reply.status(204).send();
  });
}
