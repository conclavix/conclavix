import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Workspace } from '../src/modules/workspace/service.js';
import { archiveBaseName } from '../src/modules/workspace/routes.js';
import { asBrowser, createUser, signIn } from './auth-helpers.js';
import { createTestContext, type TestContext } from './helpers.js';
import { commitAll, readZip, tempRoot } from './workspace-helpers.js';

type Role = 'owner' | 'admin' | 'member' | 'viewer';
const ROLES: Role[] = ['owner', 'admin', 'member', 'viewer'];

describe('project code API', () => {
  let ctx: TestContext;
  let root: { dir: string; cleanup: () => void };
  let workspace: Workspace;
  let projectId: string;
  let issueKey: string;
  const cookies = {} as Record<Role, string>;

  const as = (role: Role, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
    asBrowser(ctx, cookies[role], { method, url, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    root = tempRoot();
    workspace = new Workspace(root.dir);
    ctx = await createTestContext({ workspace, settingsDefaults: { mfaPolicy: 'optional' } });
    for (const role of ROLES) {
      await createUser(ctx, `${role}@example.com`, role);
      cookies[role] = (await signIn(ctx, `${role}@example.com`)).cookie;
    }
    const project = await ctx.request({
      method: 'POST',
      url: '/api/projects',
      payload: { key: 'CODE', name: 'Code', autoPlan: false },
    });
    projectId = project.json().id;
    const issue = await ctx.request({
      method: 'POST',
      url: '/api/issues',
      payload: { projectId, title: 'Write code' },
    });
    issueKey = issue.json().key;
  });

  afterAll(async () => {
    await ctx.close();
    root.cleanup();
  });

  it('creates the repository together with the project', () => {
    expect(existsSync(join(workspace.repoDir(projectId), 'HEAD'))).toBe(true);
  });

  it('lets only admins and owners create issue workspaces', async () => {
    for (const role of ['member', 'viewer'] as const) {
      const response = await as(role, 'POST', `/api/issues/${issueKey}/workspace`);
      expect(response.statusCode).toBe(403);
    }
    const created = await as('admin', 'POST', `/api/issues/${issueKey}/workspace`);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ branch: `cvx/${issueKey}`, created: true });
    expect(created.json()).not.toHaveProperty('path');
    const again = await as('owner', 'POST', `/api/issues/${issueKey}/workspace`);
    expect(again.statusCode).toBe(200);
    expect(again.json().created).toBe(false);

    const issue = await ctx.request({ method: 'GET', url: `/api/issues/${issueKey}` });
    expect(issue.json().branch).toBe(`cvx/${issueKey}`);
    const audit = await ctx.request({
      method: 'GET',
      url: '/api/audit?action=issue.workspace_created',
    });
    expect(audit.json().items).toHaveLength(1);
  });

  it('records the branch of a known clone again without a second audit entry', async () => {
    await ctx.database.collections.issues.updateOne({ key: issueKey }, { $set: { branch: null } });
    const again = await as('admin', 'POST', `/api/issues/${issueKey}/workspace`);
    expect(again.json().created).toBe(false);
    const issue = await ctx.request({ method: 'GET', url: `/api/issues/${issueKey}` });
    expect(issue.json().branch).toBe(`cvx/${issueKey}`);
    const audit = await ctx.request({
      method: 'GET',
      url: '/api/audit?action=issue.workspace_created',
    });
    expect(audit.json().items).toHaveLength(1);
  });

  it('audits a clone that was not recorded yet, for example after a failed transaction', async () => {
    await ctx.database.collections.issues.updateOne(
      { key: issueKey },
      { $set: { branch: null, workspaceCloneId: null } },
    );
    const again = await as('admin', 'POST', `/api/issues/${issueKey}/workspace`);
    expect(again.json().created).toBe(false);
    const audit = await ctx.request({
      method: 'GET',
      url: '/api/audit?action=issue.workspace_created',
    });
    expect(audit.json().items).toHaveLength(2);
  });

  it('syncs agent commits into the project repository', async () => {
    const clone = workspace.issueWorkspaceDir(projectId, issueKey);
    writeFileSync(join(clone, 'README.md'), '# Code\n');
    writeFileSync(join(clone, 'main.py'), 'print("hi")\n');
    const sha = commitAll(clone, 'Add the first files');

    expect((await as('member', 'POST', `/api/issues/${issueKey}/workspace/sync`)).statusCode).toBe(
      403,
    );
    const synced = await as('admin', 'POST', `/api/issues/${issueKey}/workspace/sync`, {});
    expect(synced.statusCode).toBe(200);
    expect(synced.json()).toMatchObject({ updated: true, after: sha });
  });

  it('lets every role read branches, history, tree, files and diffs', async () => {
    const branch = encodeURIComponent(`cvx/${issueKey}`);
    for (const role of ROLES) {
      const branches = await as(role, 'GET', `/api/projects/${projectId}/branches`);
      expect(branches.statusCode).toBe(200);
      expect(branches.json().items.map((b: { name: string }) => b.name)).toEqual([
        'main',
        `cvx/${issueKey}`,
      ]);
      const tree = await as(role, 'GET', `/api/projects/${projectId}/tree?ref=${branch}`);
      expect(tree.json().entries.map((e: { name: string }) => e.name)).toEqual([
        'main.py',
        'README.md',
      ]);
      const file = await as(
        role,
        'GET',
        `/api/projects/${projectId}/file?ref=${branch}&path=main.py`,
      );
      expect(file.json().content).toBe('print("hi")\n');
      const log = await as(role, 'GET', `/api/projects/${projectId}/commits?ref=${branch}&limit=1`);
      expect(log.json()).toMatchObject({ nextSkip: 1 });
      const sha = log.json().items[0].sha as string;
      const commit = await as(role, 'GET', `/api/projects/${projectId}/commits/${sha}`);
      expect(commit.json().diff.files).toHaveLength(2);
      const compare = await as(role, 'GET', `/api/projects/${projectId}/compare?branch=${branch}`);
      expect(compare.json()).toMatchObject({ ahead: 1, behind: 0 });
    }
  });

  it.each([
    ['ref=-n', 400],
    ['ref=--output%3D%2Ftmp%2Fx', 400],
    ['ref=main..x', 400],
    ['ref=unknown', 404],
    ['path=..%2F..%2Fetc%2Fpasswd', 400],
    ['path=%2Fetc%2Fpasswd', 400],
    ['path=-x', 400],
    ['path=nope.txt', 404],
    ['extra=1', 400],
  ])('rejects tree and file queries with %s', async (query, status) => {
    const tree = await ctx.request({
      method: 'GET',
      url: `/api/projects/${projectId}/tree?${query}`,
    });
    expect(tree.statusCode).toBe(status);
    const file = await ctx.request({
      method: 'GET',
      url: `/api/projects/${projectId}/file?path=README.md&${query}`,
    });
    expect([400, 404]).toContain(file.statusCode);
  });

  it('answers 404 for unknown projects and commits without creating a repository', async () => {
    const unknown = 'bbbbbbbbbbbbbbbbbbbbbbbb';
    const response = await ctx.request({ method: 'GET', url: `/api/projects/${unknown}/branches` });
    expect(response.statusCode).toBe(404);
    expect(existsSync(workspace.repoDir(unknown))).toBe(false);
    const commit = await ctx.request({
      method: 'GET',
      url: `/api/projects/${projectId}/commits/not-a-sha`,
    });
    expect(commit.statusCode).toBe(404);
  });

  it('streams a ZIP of a branch with a safe file name and audits it', async () => {
    const branch = `cvx/${issueKey}`;
    const response = await as(
      'viewer',
      'GET',
      `/api/projects/${projectId}/archive?ref=${encodeURIComponent(branch)}`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/zip');
    const disposition = String(response.headers['content-disposition']);
    expect(disposition).toMatch(
      new RegExp(`^attachment; filename="CODE-cvx-${issueKey}-[0-9a-f]{12}\\.zip"$`),
    );
    const prefix = disposition.slice('attachment; filename="'.length, -'.zip"'.length);
    const entries = readZip(response.rawPayload);
    expect(entries.get(`${prefix}/README.md`)?.toString('utf8')).toBe('# Code\n');
    expect(entries.get(`${prefix}/main.py`)?.toString('utf8')).toBe('print("hi")\n');

    const audit = await ctx.request({
      method: 'GET',
      url: '/api/audit?action=project.archive_downloaded',
    });
    expect(audit.json().items[0].details).toMatchObject({ projectKey: 'CODE', ref: branch });

    const bad = await ctx.request({
      method: 'GET',
      url: `/api/projects/${projectId}/archive?ref=-x`,
    });
    expect(bad.statusCode).toBe(400);
  });

  it('builds archive names only from safe characters', () => {
    expect(archiveBaseName('CVX', 'cvx/CVX-1', 'a'.repeat(40))).toBe(
      `CVX-cvx-CVX-1-${'a'.repeat(12)}`,
    );
    expect(archiveBaseName('CVX', '../"x', 'b'.repeat(40))).toBe(`CVX-x-${'b'.repeat(12)}`);
  });

  it('removes a workspace for admins only and keeps the branch', async () => {
    expect((await as('member', 'DELETE', `/api/issues/${issueKey}/workspace`)).statusCode).toBe(
      403,
    );
    const removed = await as('admin', 'DELETE', `/api/issues/${issueKey}/workspace`);
    expect(removed.statusCode).toBe(204);
    expect(existsSync(workspace.issueWorkspaceDir(projectId, issueKey))).toBe(false);
    const branches = await ctx.request({
      method: 'GET',
      url: `/api/projects/${projectId}/branches`,
    });
    expect(branches.json().items).toHaveLength(2);
    const audit = await ctx.request({
      method: 'GET',
      url: '/api/audit?action=issue.workspace_removed',
    });
    expect(audit.json().items).toHaveLength(1);
  });
  it('audits concurrent create requests for one workspace once', async () => {
    const other = await ctx.request({
      method: 'POST',
      url: '/api/issues',
      payload: { projectId, title: 'Parallel' },
    });
    const key = other.json().key as string;
    const responses = await Promise.all(
      [1, 2, 3].map(() => as('admin', 'POST', `/api/issues/${key}/workspace`)),
    );
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 200, 201]);
    const audit = await ctx.request({
      method: 'GET',
      url: '/api/audit?action=issue.workspace_created',
    });
    expect(
      audit
        .json()
        .items.filter((e: { details: { issueKey: string } }) => e.details.issueKey === key),
    ).toHaveLength(1);
  });
});

describe('project code API without a workspace', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('answers 503 and still creates projects', async () => {
    const project = await ctx.request({
      method: 'POST',
      url: '/api/projects',
      payload: { key: 'NOWS', name: 'No workspace', autoPlan: false },
    });
    expect(project.statusCode).toBe(201);
    const response = await ctx.request({
      method: 'GET',
      url: `/api/projects/${project.json().id}/branches`,
    });
    expect(response.statusCode).toBe(503);
  });
});
