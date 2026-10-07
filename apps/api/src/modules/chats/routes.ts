import type { FastifyInstance } from 'fastify';
import {
  approveChatPlanSchema,
  createChatSchema,
  listChatsQuerySchema,
  postChatMessageSchema,
  updateChatSchema,
} from '@conclavix/core';
import { parse, toObjectId } from '../../validation.js';
import { requirePrincipal } from '../auth/principal.js';
import type { ChatService } from './service.js';

interface IdParams {
  id: string;
}

/**
 * Board chats with the lead. Everyone who reads the board reads the chats; talking to the lead and
 * approving its plan are admin and owner actions (see ROUTE_PERMISSIONS), because an approved plan
 * makes the lead create a project and work.
 */
export function registerChatRoutes(app: FastifyInstance, chats: ChatService): void {
  app.get('/api/chats', async (request) => chats.list(parse(listChatsQuerySchema, request.query)));

  app.post('/api/chats', async (request, reply) => {
    const chat = await chats.create(
      parse(createChatSchema, request.body),
      requirePrincipal(request),
    );
    return reply.status(201).send(chat);
  });

  app.get<{ Params: IdParams }>('/api/chats/:id', async (request) =>
    chats.get(toObjectId(request.params.id, 'Chat')),
  );

  app.patch<{ Params: IdParams }>('/api/chats/:id', async (request) =>
    chats.update(toObjectId(request.params.id, 'Chat'), parse(updateChatSchema, request.body)),
  );

  app.post<{ Params: IdParams }>('/api/chats/:id/messages', async (request, reply) => {
    const result = await chats.postMessage(
      toObjectId(request.params.id, 'Chat'),
      parse(postChatMessageSchema, request.body),
      requirePrincipal(request),
    );
    return reply.status(202).send(result);
  });

  app.post<{ Params: IdParams }>('/api/chats/:id/approve', async (request) =>
    chats.approve(
      toObjectId(request.params.id, 'Chat'),
      parse(approveChatPlanSchema, request.body),
      requirePrincipal(request),
      request.ip,
    ),
  );

  app.get<{ Params: IdParams }>('/api/chats/:id/plan/revisions', async (request) =>
    chats.planRevisions(toObjectId(request.params.id, 'Chat')),
  );
}
