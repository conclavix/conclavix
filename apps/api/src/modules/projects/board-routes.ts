import type { FastifyInstance } from 'fastify';
import { updateBoardSchema } from '@conclavix/core';
import { parse, toObjectId } from '../../validation.js';
import type { BoardRepository } from './board.js';

interface IdParams {
  id: string;
}

/** Register reading and replacing a project's board columns. */
export function registerBoardRoutes(app: FastifyInstance, boards: BoardRepository): void {
  app.get<{ Params: IdParams }>('/api/projects/:id/board', async (request) =>
    boards.get(toObjectId(request.params.id, 'Project')),
  );

  app.put<{ Params: IdParams }>('/api/projects/:id/board', async (request) =>
    boards.replace(
      toObjectId(request.params.id, 'Project'),
      parse(updateBoardSchema, request.body),
    ),
  );
}
