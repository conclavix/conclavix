import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  commitIdSchema,
  commitLogQuerySchema,
  compareQuerySchema,
  fileQuerySchema,
  mediaContentType,
  mediaQuerySchema,
  refQuerySchema,
  removeWorkspaceQuerySchema,
  syncBranchSchema,
  treeQuerySchema,
} from '@conclavix/core';
import type { Database } from '../../db.js';
import { AppError, notFound } from '../../errors.js';
import { parse, toObjectId } from '../../validation.js';
import type { AuditLog } from '../audit/audit.js';
import { actorOf } from '../auth/principal.js';
import { matchesEtag } from '../avatars/routes.js';
import { findIssueByRef } from '../issues/queries.js';
import { pageMedia, type MediaScan } from './media.js';
import { recordIssueWorkspace } from './record.js';
import type { Workspace } from './service.js';

interface IdParams {
  id: string;
}

interface CommitParams extends IdParams {
  sha: string;
}

interface RefParams {
  ref: string;
}

/** `<KEY>-<ref>-<shortsha>` with every character outside `[A-Za-z0-9._-]` replaced by `-`. */
export function archiveBaseName(projectKey: string, ref: string, sha: string): string {
  const safeRef = ref.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'ref';
  return `${projectKey}-${safeRef}-${sha.slice(0, 12)}`;
}

interface RouteContext {
  app: FastifyInstance;
  database: Database;
  audit: AuditLog;
  required: () => Workspace;
  project: (
    request: FastifyRequest<{ Params: IdParams }>,
  ) => Promise<{ ws: Workspace; id: string; key: string }>;
}

/** Branches, history, commits, tree, files and branch comparison. */
function registerReadRoutes({ app, project }: RouteContext): void {
  /** Scans whose failed history walk was logged already; a reused scan is not logged again. */
  const reported = new WeakSet<MediaScan>();
  app.get<{ Params: IdParams }>('/api/projects/:id/branches', async (request) => {
    const { ws, id } = await project(request);
    return { items: await ws.listBranches(id) };
  });

  app.get<{ Params: IdParams }>('/api/projects/:id/commits', async (request) => {
    const { ws, id } = await project(request);
    return ws.log(id, parse(commitLogQuerySchema, request.query));
  });

  app.get<{ Params: CommitParams }>('/api/projects/:id/commits/:sha', async (request) => {
    const { ws, id } = await project(request);
    if (!commitIdSchema.safeParse(request.params.sha).success) throw notFound('Commit');
    return ws.commit(id, request.params.sha);
  });

  app.get<{ Params: IdParams }>('/api/projects/:id/tree', async (request) => {
    const { ws, id } = await project(request);
    const query = parse(treeQuerySchema, request.query);
    return ws.tree(id, query.ref, query.path);
  });

  app.get<{ Params: IdParams }>('/api/projects/:id/file', async (request) => {
    const { ws, id } = await project(request);
    const query = parse(fileQuerySchema, request.query);
    return ws.file(id, query.ref, query.path);
  });

  app.get<{ Params: IdParams }>('/api/projects/:id/media', async (request) => {
    const { ws, id } = await project(request);
    const query = parse(mediaQuerySchema, request.query);
    const scan = await ws.mediaScan(id);
    if (scan.historyError && !reported.has(scan)) {
      reported.add(scan);
      request.log.warn(
        { projectId: id, reason: scan.historyError },
        'media history walk failed; files are listed without author and date',
      );
    }
    return pageMedia(scan, query);
  });

  app.get<{ Params: IdParams }>('/api/projects/:id/compare', async (request) => {
    const { ws, id } = await project(request);
    return ws.compare(id, parse(compareQuerySchema, request.query).branch);
  });
}

/** A full commit id: content behind it never changes, so the browser may keep it. */
const FULL_COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The single byte range of a `Range` header for a body of `size` bytes: null to send the whole
 * body (no header, several ranges or another unit), 'unsatisfiable' for a range outside it.
 */
export function parseByteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start: number;
  let end: number;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

/**
 * Raw media from the repository for the Code tab, the Media tab and `repo:` images in Markdown:
 * images and videos inline, PDFs as a download only. The ETag is the blob id, so a file that did
 * not change answers 304 on every branch and commit. A single byte range is honoured, so videos
 * can seek.
 */
function registerRawRoute({ app, project }: RouteContext): void {
  app.get<{ Params: IdParams }>('/api/projects/:id/raw', async (request, reply) => {
    const { ws, id } = await project(request);
    const query = parse(fileQuerySchema, request.query);
    const contentType = mediaContentType(query.path);
    if (!contentType) {
      throw new AppError(
        415,
        'unsupported_media_type',
        'Only images, videos and PDFs are served raw',
      );
    }
    const blob = await ws.blob(id, query.ref, query.path);
    reply
      .header('etag', `"${blob.oid}"`)
      .header(
        'cache-control',
        FULL_COMMIT_ID.test(query.ref)
          ? 'private, max-age=31536000, immutable'
          : 'private, no-cache',
      )
      .header('accept-ranges', 'bytes')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    if (contentType === 'application/pdf') {
      const name = query.path
        .slice(query.path.lastIndexOf('/') + 1)
        .replace(/[^A-Za-z0-9._-]+/g, '_');
      reply.header('content-disposition', `attachment; filename="${name}"`);
    }
    if (matchesEtag(request.headers['if-none-match'], blob.oid)) {
      return reply.status(304).send();
    }
    const body = await ws.readBlob(id, blob.oid);
    const ifRange = request.headers['if-range'];
    const range =
      ifRange === undefined || String(ifRange).trim() === `"${blob.oid}"`
        ? parseByteRange(request.headers.range, body.length)
        : null;
    if (range === 'unsatisfiable') {
      return reply.status(416).header('content-range', `bytes */${body.length}`).send();
    }
    if (range) {
      return reply
        .status(206)
        .header('content-range', `bytes ${range.start}-${range.end}/${body.length}`)
        .type(contentType)
        .send(body.subarray(range.start, range.end + 1));
    }
    return reply.type(contentType).send(body);
  });
}

/** The ZIP download of a ref, audited; running downloads are cut off when the app closes. */
function registerArchiveRoute({ app, audit, project }: RouteContext): void {
  const running = new Set<Readable>();
  app.addHook('preClose', async () => {
    for (const stream of running) stream.destroy();
  });
  app.get<{ Params: IdParams }>('/api/projects/:id/archive', async (request, reply) => {
    const { ws, id, key } = await project(request);
    const { ref } = parse(refQuerySchema, request.query);
    const resolved = await ws.resolveRef(id, ref);
    const name = archiveBaseName(key, ref, resolved.sha);
    await audit.record({
      action: 'project.archive_downloaded',
      actor: actorOf(request.principal),
      ip: request.ip,
      details: { projectId: id, projectKey: key, ref, sha: resolved.sha },
    });
    const stream = await ws.archive(id, resolved.sha, name);
    stream.on('error', (error) => request.log.error({ err: error }, 'project archive failed'));
    running.add(stream);
    stream.on('close', () => running.delete(stream));
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${name}.zip"`)
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .send(stream);
  });
}

/** Creating, syncing and removing the clone of an issue. */
function registerIssueWorkspaceRoutes({ app, database, audit, required }: RouteContext): void {
  const { collections } = database;
  app.post<{ Params: RefParams }>('/api/issues/:ref/workspace', async (request, reply) => {
    const ws = required();
    const issue = await findIssueByRef(collections, request.params.ref);
    const projectId = issue.projectId.toHexString();
    const created = await ws.createIssueWorkspace(projectId, issue.key);
    await recordIssueWorkspace(
      database,
      audit,
      issue,
      created,
      actorOf(request.principal),
      request.ip,
    );
    return reply.status(created.created ? 201 : 200).send(created);
  });

  app.post<{ Params: RefParams }>('/api/issues/:ref/workspace/sync', async (request) => {
    const ws = required();
    const { force } = parse(syncBranchSchema, request.body ?? {});
    const issue = await findIssueByRef(collections, request.params.ref);
    const projectId = issue.projectId.toHexString();
    const result = await ws.syncIssueBranch(projectId, issue.key, force);
    if (result.updated) {
      await audit.record({
        action: 'issue.branch_synced',
        actor: actorOf(request.principal),
        ip: request.ip,
        details: {
          projectId,
          issueKey: issue.key,
          branch: result.branch,
          before: result.before,
          after: result.after,
          forced: result.forced,
        },
      });
    }
    return result;
  });

  app.delete<{ Params: RefParams }>('/api/issues/:ref/workspace', async (request, reply) => {
    const ws = required();
    const { force } = parse(removeWorkspaceQuerySchema, request.query);
    const issue = await findIssueByRef(collections, request.params.ref);
    const projectId = issue.projectId.toHexString();
    await ws.removeIssueWorkspace(projectId, issue.key, force);
    await audit.record({
      action: 'issue.workspace_removed',
      actor: actorOf(request.principal),
      ip: request.ip,
      details: { projectId, issueKey: issue.key, force },
    });
    return reply.status(204).send();
  });
}

/**
 * The project's code: branches, history, commits, tree, files, media, raw media, branch comparison
 * and the ZIP download for every role that may read; creating, syncing and removing issue workspaces for
 * admins.
 * Without a configured workspace every route answers 503.
 */
export function registerWorkspaceRoutes(
  app: FastifyInstance,
  workspace: Workspace | null,
  database: Database,
  audit: AuditLog,
): void {
  const { collections } = database;

  const required = (): Workspace => {
    if (!workspace) {
      throw new AppError(503, 'workspace_unavailable', 'No project workspace is configured');
    }
    return workspace;
  };

  /** Look the project up first, so an unknown id is a 404 and never creates a repository. */
  const project = async (request: FastifyRequest<{ Params: IdParams }>) => {
    const ws = required();
    const doc = await collections.projects.findOne({
      _id: toObjectId(request.params.id, 'Project'),
    });
    if (!doc) throw notFound('Project');
    return { ws, id: doc._id.toHexString(), key: doc.key };
  };

  const context: RouteContext = { app, database, audit, required, project };
  registerReadRoutes(context);
  registerRawRoute(context);
  registerArchiveRoute(context);
  registerIssueWorkspaceRoutes(context);
}
