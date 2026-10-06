import type { FastifyInstance } from 'fastify';
import { createSkillSchema, updateSkillSchema } from '@conclavix/core';
import { parse, toObjectId } from '../../validation.js';
import type { SkillRepository } from './repository.js';

interface IdParams {
  id: string;
}

/** Register skill library CRUD routes with body and ID validation. */
export function registerSkillRoutes(app: FastifyInstance, skills: SkillRepository): void {
  app.get('/api/skills', async () => ({ items: await skills.list() }));

  app.get<{ Params: IdParams }>('/api/skills/:id', async (request) =>
    skills.get(toObjectId(request.params.id, 'Skill')),
  );

  app.post('/api/skills', async (request, reply) => {
    const skill = await skills.create(parse(createSkillSchema, request.body));
    return reply.status(201).send(skill);
  });

  app.patch<{ Params: IdParams }>('/api/skills/:id', async (request) =>
    skills.update(toObjectId(request.params.id, 'Skill'), parse(updateSkillSchema, request.body)),
  );

  app.delete<{ Params: IdParams }>('/api/skills/:id', async (request, reply) => {
    await skills.remove(toObjectId(request.params.id, 'Skill'));
    return reply.status(204).send();
  });
}
