import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ObjectId } from 'mongodb';
import { createSecretSchema, revealSecretSchema, updateSecretSchema } from '@conclavix/core';
import type { Database } from '../../db.js';
import { AppError, notFound } from '../../errors.js';
import { parse, toObjectId } from '../../validation.js';
import type { AuditLog } from '../audit/audit.js';
import type { Auth } from '../auth/better-auth.js';
import { actorOf, requirePrincipal } from '../auth/principal.js';
import type { SecretRepository } from './repository.js';

interface ProjectParams {
  id: string;
}

interface SecretParams extends ProjectParams {
  secretId: string;
}

/** Failed reveal attempts per user before reveals pause, and for how long. */
const REVEAL_FAILURES = 5;
const REVEAL_WINDOW_MS = 10 * 60_000;

/** Counts failed password checks per user in this process, so a session cannot guess endlessly. */
class RevealLimiter {
  private readonly failures = new Map<string, number[]>();

  blocked(userId: string, now = Date.now()): boolean {
    const recent = (this.failures.get(userId) ?? []).filter((at) => now - at < REVEAL_WINDOW_MS);
    this.failures.set(userId, recent);
    return recent.length >= REVEAL_FAILURES;
  }

  fail(userId: string, now = Date.now()): void {
    this.failures.set(userId, [...(this.failures.get(userId) ?? []), now]);
  }

  clear(userId: string): void {
    this.failures.delete(userId);
  }
}

/** Checks the signed-in user's password again; false for users without a password. */
export type PasswordCheck = (userId: string, password: string) => Promise<boolean>;

/** Verify against the credential account better-auth keeps for the user. */
export function passwordCheck(auth: Auth, database: Database): PasswordCheck {
  return async (userId, password) => {
    if (!ObjectId.isValid(userId)) return false;
    const account = await database.db
      .collection<{ password?: string }>('account')
      .findOne({ userId: new ObjectId(userId), providerId: 'credential' });
    if (!account?.password) return false;
    const context = await auth.$context;
    return context.password.verify({ hash: account.password, password });
  };
}

const projectOf = async (database: Database, id: string): Promise<ObjectId> => {
  const projectId = toObjectId(id, 'Project');
  const project = await database.collections.projects.findOne(
    { _id: projectId },
    { projection: { _id: 1 } },
  );
  if (!project) throw notFound('Project');
  return projectId;
};

const auditEntry = (request: FastifyRequest, action: string, details: Record<string, unknown>) => ({
  action,
  actor: actorOf(requirePrincipal(request)),
  ip: request.ip,
  details,
});

/**
 * Project secrets for owners and admins (settings capability). The value is write-only; only an
 * owner can read it back, after entering the own password again. Every change and every reveal
 * commits together with its audit entry, which never holds the value.
 */
export function registerSecretRoutes(
  app: FastifyInstance,
  database: Database,
  secrets: SecretRepository,
  audit: AuditLog,
  checkPassword: PasswordCheck,
): void {
  registerManageRoutes(app, database, secrets, audit);
  registerRevealRoute(app, database, secrets, audit, checkPassword);
}

/** List, create, change and delete; metadata only. */
function registerManageRoutes(
  app: FastifyInstance,
  database: Database,
  secrets: SecretRepository,
  audit: AuditLog,
): void {
  app.get<{ Params: ProjectParams }>('/api/projects/:id/secrets', async (request) => {
    const projectId = await projectOf(database, request.params.id);
    const [items, agents] = await Promise.all([secrets.list(projectId), secrets.agentOptions()]);
    return { items, agents };
  });

  app.post<{ Params: ProjectParams }>('/api/projects/:id/secrets', async (request, reply) => {
    const projectId = await projectOf(database, request.params.id);
    const input = parse(createSecretSchema, request.body);
    const secret = await database.inTransaction(async (session) => {
      const created = await secrets.create(projectId, input, session);
      await audit.write(
        auditEntry(request, 'secret.created', {
          secretId: created.id,
          projectId: created.projectId,
          name: created.name,
          envName: created.envName,
          agentIds: created.agentIds,
        }),
        session,
      );
      return created;
    });
    return reply.status(201).send(secret);
  });

  app.patch<{ Params: SecretParams }>('/api/projects/:id/secrets/:secretId', async (request) => {
    const projectId = await projectOf(database, request.params.id);
    const id = toObjectId(request.params.secretId, 'Secret');
    const input = parse(updateSecretSchema, request.body);
    return database.inTransaction(async (session) => {
      const { secret, changes } = await secrets.update(projectId, id, input, session);
      await audit.write(
        auditEntry(request, 'secret.updated', {
          secretId: secret.id,
          projectId: secret.projectId,
          name: secret.name,
          envName: secret.envName,
          changes,
        }),
        session,
      );
      return secret;
    });
  });

  app.delete<{ Params: SecretParams }>(
    '/api/projects/:id/secrets/:secretId',
    async (request, reply) => {
      const projectId = await projectOf(database, request.params.id);
      const id = toObjectId(request.params.secretId, 'Secret');
      await database.inTransaction(async (session) => {
        const removed = await secrets.remove(projectId, id, session);
        await audit.write(
          auditEntry(request, 'secret.deleted', {
            secretId: id.toHexString(),
            projectId: projectId.toHexString(),
            name: removed.name,
            envName: removed.envName,
          }),
          session,
        );
      });
      return reply.status(204).send();
    },
  );
}

/** Owners only, after the password check; failures are counted and audited. */
function registerRevealRoute(
  app: FastifyInstance,
  database: Database,
  secrets: SecretRepository,
  audit: AuditLog,
  checkPassword: PasswordCheck,
): void {
  const limiter = new RevealLimiter();
  app.post<{ Params: SecretParams }>(
    '/api/projects/:id/secrets/:secretId/reveal',
    async (request, reply) => {
      const principal = requirePrincipal(request);
      if (principal.kind !== 'user') {
        throw new AppError(403, 'reauth_required', 'Revealing a secret needs a signed-in owner');
      }
      if (principal.role !== 'owner') {
        throw new AppError(403, 'owner_required', 'Only an owner can reveal a secret');
      }
      const projectId = await projectOf(database, request.params.id);
      const id = toObjectId(request.params.secretId, 'Secret');
      const { password } = parse(revealSecretSchema, request.body);
      if (limiter.blocked(principal.userId)) {
        throw new AppError(429, 'too_many_attempts', 'Too many wrong passwords; try again later');
      }
      const doc = await secrets.get(projectId, id);
      const details = {
        secretId: id.toHexString(),
        projectId: projectId.toHexString(),
        name: doc.name,
        envName: doc.envName,
      };
      if (!(await checkPassword(principal.userId, password))) {
        limiter.fail(principal.userId);
        await audit.record(auditEntry(request, 'secret.reveal_failed', details));
        throw new AppError(403, 'invalid_password', 'The password is not correct');
      }
      limiter.clear(principal.userId);
      const value = secrets.open(doc);
      // The audit entry is written before the value leaves the server; without it, no value.
      await database.inTransaction((session) =>
        audit.write(auditEntry(request, 'secret.revealed', details), session),
      );
      return reply.header('cache-control', 'no-store').send({ value });
    },
  );
}
