import type { FastifyInstance } from 'fastify';
import {
  answerDecisionSchema,
  dismissDecisionSchema,
  listDecisionsQuerySchema,
} from '@conclavix/core';
import { parse, toObjectId } from '../../validation.js';
import { authorOf, requirePrincipal } from '../auth/principal.js';
import type { DecisionService } from './service.js';

interface IdParams {
  id: string;
}

/** Register the board API for decisions agents asked the board for. */
export function registerDecisionRoutes(app: FastifyInstance, decisions: DecisionService): void {
  app.get('/api/decisions', async (request) =>
    decisions.list(parse(listDecisionsQuerySchema, request.query)),
  );

  app.get('/api/decisions/count', async () => decisions.count());

  app.post<{ Params: IdParams }>('/api/decisions/:id/answer', async (request) =>
    decisions.answer(
      toObjectId(request.params.id, 'Decision'),
      parse(answerDecisionSchema, request.body),
      authorOf(requirePrincipal(request)),
    ),
  );

  app.post<{ Params: IdParams }>('/api/decisions/:id/dismiss', async (request) =>
    decisions.dismiss(
      toObjectId(request.params.id, 'Decision'),
      parse(dismissDecisionSchema, request.body ?? {}),
      authorOf(requirePrincipal(request)),
    ),
  );
}
