import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { diffQuerySchema, downloadContentType, type FileQuery } from '@conclavix/core';
import { parse } from '../../validation.js';
import { matchesEtag } from '../avatars/routes.js';
import type { Workspace } from './service.js';

/** A full commit id: content behind it never changes, so the browser may keep it. */
export const FULL_COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Headers of every raw response: no sniffing, and nothing may run if it is opened directly. */
export const RAW_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/** Cache policy of a raw response: immutable for a full commit id, revalidated for a branch. */
export const rawCacheControl = (ref: string): string =>
  FULL_COMMIT_ID.test(ref) ? 'private, max-age=31536000, immutable' : 'private, no-cache';

/**
 * `Content-Disposition: attachment` for the last segment of `path`: an ASCII fallback in
 * `filename` and the exact name in `filename*` (RFC 6266 / RFC 5987).
 */
export function attachmentDisposition(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1) || 'download';
  const ascii = name.replace(/[^A-Za-z0-9._+-]+/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Remember running response streams so closing the app cuts them off; returns the function
 * that adds one.
 */
export function streamTracker(app: FastifyInstance): (stream: Readable) => void {
  const running = new Set<Readable>();
  app.addHook('preClose', async () => {
    for (const stream of running) stream.destroy();
  });
  return (stream) => {
    running.add(stream);
    stream.on('close', () => running.delete(stream));
  };
}

/**
 * Send any file of the repository as a download: always an attachment, octet-stream unless it is
 * a raster image, video or PDF, streamed from git with a known length. The ETag is the blob id.
 * A HEAD request gets the same answer without starting git, so the UI can check a download
 * (413, 404) before the browser navigates to it.
 */
export async function sendDownload(
  request: FastifyRequest,
  reply: FastifyReply,
  target: { ws: Workspace; id: string; query: FileQuery; track: (stream: Readable) => void },
): Promise<FastifyReply> {
  const { ws, id, query, track } = target;
  const blob = await ws.downloadBlob(id, query.ref, query.path);
  reply
    .header('etag', `"${blob.oid}"`)
    .header('cache-control', rawCacheControl(query.ref))
    .header('accept-ranges', 'none')
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', RAW_CSP)
    .header('content-disposition', attachmentDisposition(query.path));
  if (matchesEtag(request.headers['if-none-match'], blob.oid)) {
    return reply.status(304).send();
  }
  reply.header('content-length', String(blob.size)).type(downloadContentType(query.path));
  // Fastify keeps our Content-Length on HEAD only for a stream body; an empty one starts no git.
  if (request.method === 'HEAD') return reply.send(Readable.from([]));
  const stream = blob.open();
  stream.on('error', (error) => request.log.error({ err: error }, 'file download failed'));
  track(stream);
  return reply.send(stream);
}

interface IdParams {
  id: string;
}

/** `GET /diff`: a commit, or two refs from their merge base or directly, for review. */
export function registerDiffRoute(
  app: FastifyInstance,
  project: (
    request: FastifyRequest<{ Params: IdParams }>,
  ) => Promise<{ ws: Workspace; id: string }>,
): void {
  app.get<{ Params: IdParams }>('/api/projects/:id/diff', async (request) => {
    const { ws, id } = await project(request);
    return ws.refDiff(id, parse(diffQuerySchema, request.query));
  });
}
