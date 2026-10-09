import type { FastifyInstance } from 'fastify';
import { createAgentSchema, updateAgentSchema } from '@conclavix/core';
import { parse, toObjectId } from '../../validation.js';
import type { AuditLog } from '../audit/audit.js';
import { actorOf, requirePrincipal } from '../auth/principal.js';
import type { AgentRepository } from './repository.js';

interface IdParams {
  id: string;
}

/**
 * Register agent CRUD and org-chart routes, validating request bodies and resource IDs. Changes of
 * the project default (where the agent may work), of the code access (whether it may write and
 * run code in the coding-agent sandbox) and of git integration (whether it may merge branches and
 * fast-forward main) get audit entries, written in the same transaction.
 */
export function registerAgentRoutes(
  app: FastifyInstance,
  agents: AgentRepository,
  audit: AuditLog,
): void {
  app.get('/api/agents', async () => ({ items: await agents.list() }));

  app.get('/api/org-chart', async () => ({ roots: await agents.orgChart() }));

  app.get<{ Params: IdParams }>('/api/agents/:id', async (request) =>
    agents.get(toObjectId(request.params.id, 'Agent')),
  );

  app.post('/api/agents', async (request, reply) => {
    const principal = requirePrincipal(request);
    const input = parse(createAgentSchema, request.body);
    const agent = await agents.create(input, async (created, session) => {
      const entry = (action: string, from: string, to: string) =>
        audit.write(
          {
            action,
            actor: actorOf(principal),
            ip: request.ip,
            details: { agentId: created._id.toHexString(), agent: created.name, from, to },
          },
          session,
        );
      if (input.codeAccess !== 'none') {
        await entry('agent.code_access_changed', 'none', input.codeAccess);
      }
      if (input.gitIntegration) {
        await entry('agent.git_integration_changed', 'false', 'true');
      }
    });
    return reply.status(201).send(agent);
  });

  app.patch<{ Params: IdParams }>('/api/agents/:id', async (request) => {
    const principal = requirePrincipal(request);
    const input = parse(updateAgentSchema, request.body);
    const { projectDefault, codeAccess, gitIntegration } = input;
    return agents.update(toObjectId(request.params.id, 'Agent'), input, async (before, session) => {
      const entry = (action: string, from: string, to: string) =>
        audit.write(
          {
            action,
            actor: actorOf(principal),
            ip: request.ip,
            details: { agentId: before._id.toHexString(), agent: before.name, from, to },
          },
          session,
        );
      const previousDefault = before.projectDefault ?? 'enabled';
      if (projectDefault !== undefined && projectDefault !== previousDefault) {
        await entry('agent.project_default_changed', previousDefault, projectDefault);
      }
      const previousAccess = before.codeAccess ?? 'none';
      if (codeAccess !== undefined && codeAccess !== previousAccess) {
        await entry('agent.code_access_changed', previousAccess, codeAccess);
      }
      const previousIntegration = before.gitIntegration ?? false;
      if (gitIntegration !== undefined && gitIntegration !== previousIntegration) {
        await entry(
          'agent.git_integration_changed',
          String(previousIntegration),
          String(gitIntegration),
        );
      }
    });
  });

  app.delete<{ Params: IdParams }>('/api/agents/:id', async (request, reply) => {
    await agents.remove(toObjectId(request.params.id, 'Agent'));
    return reply.status(204).send();
  });
}
