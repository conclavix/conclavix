import type { FastifyInstance } from 'fastify';
import {
  SKILL_SOURCE_PROVIDER_INFO,
  createSkillSourceSchema,
  directorySearchSchema,
  directorySlugSchema,
  importDirectorySkillSchema,
  updateSkillSourceSchema,
} from '@conclavix/core';
import type { Database } from '../../db.js';
import { notFound } from '../../errors.js';
import { parse, toObjectId } from '../../validation.js';
import type { AuditLog } from '../audit/audit.js';
import { actorOf, requirePrincipal } from '../auth/principal.js';
import type { SkillSourceRepository } from './repository.js';
import type { SkillDirectoryService } from './service.js';

interface IdParams {
  id: string;
}

interface SlugParams extends IdParams {
  slug: string;
}

const sourceId = (id: string) => toObjectId(id, 'Skill directory');

/**
 * Skill directory sources (settings capability) and browsing/importing (agents capability, as
 * importing writes to the skill library). The API key is write-only and never logged or audited.
 */
export function registerSkillSourceRoutes(
  app: FastifyInstance,
  database: Database,
  sources: SkillSourceRepository,
  directory: SkillDirectoryService,
  audit: AuditLog,
): void {
  app.get('/api/skill-sources', async () => ({
    items: await sources.list(),
    providers: Object.values(SKILL_SOURCE_PROVIDER_INFO),
  }));
  registerSourceAdminRoutes(app, database, sources, audit);
  registerBrowseRoutes(app, directory);
}

/** Create, change and delete sources; each change commits together with its audit entry. */
function registerSourceAdminRoutes(
  app: FastifyInstance,
  database: Database,
  sources: SkillSourceRepository,
  audit: AuditLog,
): void {
  app.post('/api/skill-sources', async (request, reply) => {
    const principal = requirePrincipal(request);
    const input = parse(createSkillSourceSchema, request.body);
    const source = await database.inTransaction(async (session) => {
      const created = await sources.create(input, session);
      await audit.write(
        {
          action: 'skill_source.created',
          actor: actorOf(principal),
          ip: request.ip,
          details: {
            sourceId: created.id,
            name: created.name,
            provider: created.provider,
            customBaseUrl: !created.baseUrlIsDefault,
            apiKey: created.hasApiKey ? 'set' : 'none',
            enabled: created.enabled,
          },
        },
        session,
      );
      return created;
    });
    return reply.status(201).send(source);
  });

  app.patch<{ Params: IdParams }>('/api/skill-sources/:id', async (request) => {
    const principal = requirePrincipal(request);
    const id = sourceId(request.params.id);
    const input = parse(updateSkillSourceSchema, request.body);
    return database.inTransaction(async (session) => {
      const { source, changes } = await sources.update(id, input, session);
      await audit.write(
        {
          action: 'skill_source.updated',
          actor: actorOf(principal),
          ip: request.ip,
          details: { sourceId: source.id, name: source.name, changes },
        },
        session,
      );
      return source;
    });
  });

  app.delete<{ Params: IdParams }>('/api/skill-sources/:id', async (request, reply) => {
    const principal = requirePrincipal(request);
    const id = sourceId(request.params.id);
    await database.inTransaction(async (session) => {
      const removed = await sources.remove(id, session);
      await audit.write(
        {
          action: 'skill_source.deleted',
          actor: actorOf(principal),
          ip: request.ip,
          details: { sourceId: id.toHexString(), name: removed.name, provider: removed.provider },
        },
        session,
      );
    });
    return reply.status(204).send();
  });
}

/** Provider calls: connection test, categories, search, detail and import. */
function registerBrowseRoutes(app: FastifyInstance, directory: SkillDirectoryService): void {
  app.post<{ Params: IdParams }>('/api/skill-sources/:id/test', async (request) => {
    const status = await directory.status(sourceId(request.params.id));
    return { ok: true, ...status };
  });

  app.get<{ Params: IdParams }>('/api/skill-sources/:id/categories', async (request) =>
    directory.categories(sourceId(request.params.id)),
  );

  app.get<{ Params: IdParams }>('/api/skill-sources/:id/skills', async (request) =>
    directory.search(sourceId(request.params.id), parse(directorySearchSchema, request.query)),
  );

  app.get<{ Params: SlugParams }>('/api/skill-sources/:id/skills/:slug', async (request) => {
    const id = sourceId(request.params.id);
    const slug = directorySlugSchema.safeParse(request.params.slug);
    if (!slug.success) throw notFound('Skill');
    return directory.detail(id, slug.data);
  });

  app.post<{ Params: IdParams }>('/api/skill-sources/:id/import', async (request, reply) => {
    const principal = requirePrincipal(request);
    const id = sourceId(request.params.id);
    const input = parse(importDirectorySkillSchema, request.body);
    const result = await directory.import(id, input, actorOf(principal), request.ip);
    return reply.status(result.replaced ? 200 : 201).send(result);
  });
}
