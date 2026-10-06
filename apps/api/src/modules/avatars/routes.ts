import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, notFound } from '../../errors.js';
import { parse } from '../../validation.js';
import { MAX_UPLOAD_BYTES, processAvatar } from './image.js';
import { ownerHandler, type AvatarOwnerHandlers } from './owners.js';
import type { AvatarRepository } from './repository.js';
import { avatarUrl } from './url.js';

const paramsSchema = z.object({
  type: z.enum(['agent', 'user']),
  id: z.string().min(1).max(128),
});

const CACHE_CONTROL = 'private, max-age=60, must-revalidate';

/** True when an If-None-Match header names the current ETag, ignoring weak markers. */
export function matchesEtag(header: string | string[] | undefined, etag: string): boolean {
  const value = Array.isArray(header) ? header.join(',') : header;
  if (!value) {
    return false;
  }
  return value
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''))
    .some((tag) => tag === '*' || tag === `"${etag}"`);
}

/** Read the single uploaded file, enforcing the size limit while streaming. */
async function readUpload(request: FastifyRequest): Promise<Buffer> {
  if (!request.isMultipart()) {
    throw new AppError(415, 'unsupported_media_type', 'Expected a multipart/form-data upload');
  }
  const file = await request.file();
  if (!file) {
    throw new AppError(400, 'invalid_request', 'No file was uploaded');
  }
  return file.toBuffer();
}

/** Apply the headers every avatar image response carries. */
const imageHeaders = (reply: FastifyReply, etag: string): FastifyReply =>
  reply
    .header('etag', `"${etag}"`)
    .header('cache-control', CACHE_CONTROL)
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; sandbox");

/**
 * Register avatar upload, download, and removal for every owner type in a scope of its own,
 * so the multipart parser only applies here. Owner types without a handler answer 404.
 */
export function registerAvatarRoutes(
  app: FastifyInstance,
  avatars: AvatarRepository,
  handlers: AvatarOwnerHandlers,
): void {
  void app.register(async (scope) => {
    await scope.register(multipart, {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 1 },
    });

    scope.get('/api/avatars/:type/:id', async (request, reply) => {
      const owner = parse(paramsSchema, request.params);
      const handler = ownerHandler(handlers, owner.type);
      const avatar = await avatars.find(owner);
      if (!avatar) {
        throw notFound(`${handler.label} avatar`);
      }
      imageHeaders(reply, avatar.etag).header('last-modified', avatar.updatedAt.toUTCString());
      if (matchesEtag(request.headers['if-none-match'], avatar.etag)) {
        return reply.status(304).send();
      }
      return reply.type(avatar.contentType).send(avatar.data);
    });

    scope.put('/api/avatars/:type/:id', async (request) => {
      const owner = parse(paramsSchema, request.params);
      const handler = ownerHandler(handlers, owner.type);
      await handler.assertExists(owner.id);
      await handler.assertCanWrite(request, owner.id);
      const image = await processAvatar(await readUpload(request));
      const saved = await avatars.save(owner, handler, image);
      return { ...saved, url: avatarUrl(owner.type, owner.id, saved.etag) };
    });

    scope.delete('/api/avatars/:type/:id', async (request, reply) => {
      const owner = parse(paramsSchema, request.params);
      const handler = ownerHandler(handlers, owner.type);
      await handler.assertExists(owner.id);
      await handler.assertCanWrite(request, owner.id);
      await avatars.remove(owner, handler);
      return reply.status(204).send();
    });
  });
}
