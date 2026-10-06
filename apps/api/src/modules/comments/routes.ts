import type { FastifyInstance } from 'fastify';
import { createCommentSchema, pageQuerySchema } from '@conclavix/core';
import { parse } from '../../validation.js';
import { authorOf, requirePrincipal } from '../auth/principal.js';
import type { CommentRepository } from './repository.js';

interface RefParams {
  ref: string;
}

/** Register the board API routes for issue comments. */
export function registerCommentRoutes(app: FastifyInstance, comments: CommentRepository): void {
  app.get<{ Params: RefParams }>('/api/issues/:ref/comments', async (request) =>
    comments.list(request.params.ref, parse(pageQuerySchema, request.query)),
  );

  app.post<{ Params: RefParams }>('/api/issues/:ref/comments', async (request, reply) => {
    const comment = await comments.create(
      request.params.ref,
      parse(createCommentSchema, request.body),
      authorOf(requirePrincipal(request)),
    );
    return reply.status(201).send(comment);
  });
}
