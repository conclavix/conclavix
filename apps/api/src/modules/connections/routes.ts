import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createConnectionSchema, updateConnectionSchema } from '@conclavix/core';
import type { Database } from '../../db.js';
import { AppError } from '../../errors.js';
import { parse, toObjectId } from '../../validation.js';
import type { AuditLog } from '../audit/audit.js';
import { actorOf, requirePrincipal } from '../auth/principal.js';
import type { ConnectionService } from './service.js';
import { CONNECTION_TYPES, typeInfo } from './types/index.js';

interface IdParams {
  id: string;
}

const connectionId = (id: string) => toObjectId(id, 'Connection');

const auditEntry = (request: FastifyRequest, action: string, details: Record<string, unknown>) => ({
  action,
  actor: actorOf(requirePrincipal(request)),
  ip: request.ip,
  details,
});

/** Private networks are an owner's decision: the instance's own network is at stake. */
function requireOwnerForPrivate(request: FastifyRequest, wanted: boolean | undefined): void {
  if (wanted === true && requirePrincipal(request).role !== 'owner') {
    throw new AppError(403, 'owner_required', 'Only an owner can allow private networks');
  }
}

/**
 * Connections (settings capability: owners and admins). Credential values are write-only and
 * never logged or audited; only an owner may let a connection reach private networks.
 */
export function registerConnectionRoutes(
  app: FastifyInstance,
  database: Database,
  connections: ConnectionService,
  audit: AuditLog,
): void {
  registerListRoute(app, database, connections);

  app.post('/api/connections', async (request, reply) => {
    const input = parse(createConnectionSchema, request.body);
    requireOwnerForPrivate(request, input.allowPrivateNetwork);
    const created = await database.inTransaction(async (session) => {
      const connection = await connections.create(input, session);
      await audit.write(
        auditEntry(request, 'connection.created', {
          connectionId: connection.id,
          name: connection.name,
          type: connection.type,
          scope: connection.scope,
          projectId: connection.projectId,
          agentIds: connection.agentIds,
          allowPrivateNetwork: connection.allowPrivateNetwork,
          credentials: connection.credentials.filter((entry) => entry.set).map((e) => e.key),
        }),
        session,
      );
      return connection;
    });
    return reply.status(201).send(created);
  });

  app.patch<{ Params: IdParams }>('/api/connections/:id', async (request) => {
    const id = connectionId(request.params.id);
    const input = parse(updateConnectionSchema, request.body);
    requireOwnerForPrivate(request, input.allowPrivateNetwork);
    return database.inTransaction(async (session) => {
      const current = await connections.getDoc(id, session);
      // An admin may not keep editing what an owner opened up to private networks.
      requireOwnerForPrivate(
        request,
        current.allowPrivateNetwork &&
          (input.config !== undefined || input.credentials !== undefined),
      );
      const { connection, changes } = await connections.update(id, input, session);
      await audit.write(
        auditEntry(request, 'connection.updated', {
          connectionId: connection.id,
          name: connection.name,
          changes,
        }),
        session,
      );
      return connection;
    });
  });

  app.delete<{ Params: IdParams }>('/api/connections/:id', async (request, reply) => {
    const id = connectionId(request.params.id);
    await database.inTransaction(async (session) => {
      const removed = await connections.remove(id, session);
      await audit.write(
        auditEntry(request, 'connection.deleted', {
          connectionId: id.toHexString(),
          name: removed.name,
          type: removed.type,
        }),
        session,
      );
    });
    return reply.status(204).send();
  });

  app.post<{ Params: IdParams }>('/api/connections/:id/test', async (request) => {
    const id = connectionId(request.params.id);
    const connection = await connections.test(id);
    await audit.record(
      auditEntry(request, 'connection.tested', {
        connectionId: connection.id,
        name: connection.name,
        ok: connection.lastTest?.ok ?? false,
      }),
    );
    return connection;
  });
}

/** The list with the type descriptions and the agents the form offers. */
function registerListRoute(
  app: FastifyInstance,
  database: Database,
  connections: ConnectionService,
): void {
  app.get<{ Querystring: { projectId?: string } }>('/api/connections', async (request) => {
    const projectId = request.query.projectId;
    const filter = projectId === undefined ? undefined : toObjectId(projectId, 'Project');
    const agents = await database.collections.agents
      .find({}, { projection: { name: 1, codeAccess: 1 } })
      .sort({ name: 1 })
      .toArray();
    return {
      items: await connections.list(filter),
      types: [...CONNECTION_TYPES.values()].map(typeInfo),
      agents: agents.map((agent) => ({
        id: agent._id.toHexString(),
        name: agent.name,
        codeAccess: agent.codeAccess ?? 'none',
      })),
    };
  });
}
