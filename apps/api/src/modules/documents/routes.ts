import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { documentKeySchema, writeDocumentSchema } from '@conclavix/core';
import { parse } from '../../validation.js';
import { authorOf, requirePrincipal } from '../auth/principal.js';
import type { DocumentRepository } from './repository.js';

interface DocumentParams {
  ref: string;
  key: string;
}

const revisionParamSchema = z.coerce.number().int().min(1);

/** Register the board API routes for versioned issue documents. */
export function registerDocumentRoutes(app: FastifyInstance, documents: DocumentRepository): void {
  app.get<{ Params: { ref: string } }>('/api/issues/:ref/documents', async (request) => ({
    items: await documents.list(request.params.ref),
  }));

  app.get<{ Params: DocumentParams }>('/api/issues/:ref/documents/:key', async (request) =>
    documents.get(request.params.ref, parse(documentKeySchema, request.params.key)),
  );

  app.get<{ Params: DocumentParams }>(
    '/api/issues/:ref/documents/:key/revisions',
    async (request) => ({
      items: await documents.revisions(
        request.params.ref,
        parse(documentKeySchema, request.params.key),
      ),
    }),
  );

  app.get<{ Params: DocumentParams & { revision: string } }>(
    '/api/issues/:ref/documents/:key/revisions/:revision',
    async (request) =>
      documents.get(
        request.params.ref,
        parse(documentKeySchema, request.params.key),
        parse(revisionParamSchema, request.params.revision),
      ),
  );

  app.put<{ Params: DocumentParams }>('/api/issues/:ref/documents/:key', async (request, reply) => {
    const { document, created } = await documents.write(
      request.params.ref,
      parse(documentKeySchema, request.params.key),
      parse(writeDocumentSchema, request.body),
      authorOf(requirePrincipal(request)),
    );
    return reply.status(created ? 201 : 200).send(document);
  });
}
