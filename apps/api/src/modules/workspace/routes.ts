import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  commitIdSchema,
  commitLogQuerySchema,
  compareQuerySchema,
  fileQuerySchema,
  imageContentType,
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

  app.get<{ Params: IdParams }>('/api/projects/:id/compare', async (request) => {
    const { ws, id } = await project(request);
    return ws.compare(id, parse(compareQuerySchema, request.query).branch);
  });
}

/** A full commit id: content behind it never changes, so the browser may keep it. */
const FULL_COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Raw images from the repository for the Code tab and for `repo:` images in Markdown. The ETag is
 * the blob id, so an image that did not change answers 304 on every branch and commit.
 */
function registerRawRoute({ app, project }: RouteContext): void {
  app.get<{ Params: IdParams }>('/api/projects/:id/raw', async (request, reply) => {
    const { ws, id } = await project(request);
    const query = parse(fileQuerySchema, request.query);
    const contentType = imageContentType(query.path);
    if (!contentType) {
      throw new AppError(415, 'unsupported_media_type', 'Only images are served raw');
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
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    if (matchesEtag(request.headers['if-none-match'], blob.oid)) {
      return reply.status(304).send();
    }
    return reply.type(contentType).send(await ws.readBlob(id, blob.oid));
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
 * The project's code: branches, history, commits, tree, files, raw images, branch comparison
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
