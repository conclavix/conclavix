import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { Workspace, type WorkspaceLimits } from '../src/modules/workspace/service.js';
import { asBrowser, createUser, signIn } from './auth-helpers.js';
import { createTestContext, type TestContext } from './helpers.js';
import { commitAll, git, tempRoot } from './workspace-helpers.js';

/** A 1x1 transparent PNG. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
/** A file with NUL bytes, which git and the viewer treat as binary. */
export const ZIP_V1 = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 1, 2, 3]);
export const ZIP_V2 = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 9, 9, 9, 9]);
export const MAX_DOWNLOAD = 4096;

const lines = (count: number, word: string) =>
  Array.from({ length: count }, (_, i) => `${word} ${i}`).join('\n') + '\n';

export type Role = 'owner' | 'admin' | 'member' | 'viewer';
export const ROLES: Role[] = ['owner', 'admin', 'member', 'viewer'];

export interface BrowseFixture {
  ctx: TestContext;
  workspace: Workspace;
  projectId: string;
  /** The issue branch, `cvx/<KEY>`. */
  branch: string;
  /** First commit: on main and the branch. */
  base: string;
  /** Commit only main has. */
  mainOnly: string;
  /** Second commit: only on the branch. */
  head: string;
  cookies: Record<Role, string>;
  get(url: string, role?: Role, headers?: Record<string, string>): Promise<LightMyRequestResponse>;
  cleanup(): Promise<void>;
}

function writeBase(clone: string): void {
  mkdirSync(join(clone, 'src', 'lib'), { recursive: true });
  mkdirSync(join(clone, 'assets'), { recursive: true });
  mkdirSync(join(clone, 'docs', 'a b'), { recursive: true });
  writeFileSync(join(clone, 'README.md'), '# Browse\n');
  writeFileSync(join(clone, 'src', 'app.ts'), 'export const a = 1;\n');
  writeFileSync(join(clone, 'src', 'lib', 'util.ts'), 'export const u = 1;\n');
  writeFileSync(join(clone, 'docs', 'a b', 'notes.md'), '# Notes\n');
  writeFileSync(join(clone, 'assets', 'logo.png'), PNG);
  writeFileSync(join(clone, 'assets', 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  writeFileSync(join(clone, 'assets', 'page.html'), '<script>alert(1)</script>\n');
  writeFileSync(join(clone, 'assets', 'app.js'), 'alert(1);\n');
  writeFileSync(join(clone, 'assets', 'data.zip'), ZIP_V1);
  writeFileSync(join(clone, 'assets', 'big.bin'), Buffer.alloc(MAX_DOWNLOAD + 1, 1));
  writeFileSync(join(clone, 'Übersicht "Plan".txt'), 'plan\n');
  writeFileSync(join(clone, 'long.txt'), lines(120, 'old'));
  mkdirSync(join(clone, 'moved'), { recursive: true });
  writeFileSync(join(clone, 'moved', 'before.txt'), lines(10, 'line'));
}

/**
 * A project whose repository has: a first commit on main and the issue branch, one more commit
 * only on main, one more only on the branch (a text change, a binary change and a long diff),
 * a tag `v1` at the first commit and a commit no ref reaches.
 */
export async function createBrowseFixture(
  key: string,
  limits: Partial<WorkspaceLimits> = {},
): Promise<BrowseFixture & { dangling: string }> {
  const root = tempRoot();
  const workspace = new Workspace(root.dir, {
    limits: { maxDownloadBytes: MAX_DOWNLOAD, maxFilePatchLines: 50, ...limits },
  });
  const ctx = await createTestContext({ workspace, settingsDefaults: { mfaPolicy: 'optional' } });
  const cookies = {} as Record<Role, string>;
  for (const role of ROLES) {
    await createUser(ctx, `${role}@example.com`, role);
    cookies[role] = (await signIn(ctx, `${role}@example.com`)).cookie;
  }
  const project = await ctx.request({
    method: 'POST',
    url: '/api/projects',
    payload: { key, name: 'Browse', autoPlan: false },
  });
  const projectId = project.json().id as string;
  const issue = await ctx.request({
    method: 'POST',
    url: '/api/issues',
    payload: { projectId, title: 'Browse' },
  });
  const issueKey = issue.json().key as string;
  const created = await ctx.request({ method: 'POST', url: `/api/issues/${issueKey}/workspace` });
  const branch = created.json().branch as string;
  const clone = workspace.issueWorkspaceDir(projectId, issueKey);
  const bare = workspace.repoDir(projectId);

  writeBase(clone);
  const base = commitAll(clone, 'Add the base files');
  git(clone, 'push', '--quiet', bare, `HEAD:refs/heads/main`);
  git(clone, 'tag', 'v1');
  git(clone, 'push', '--quiet', bare, 'refs/tags/v1');

  git(clone, 'checkout', '--quiet', '-b', 'main-work');
  writeFileSync(join(clone, 'MAIN.md'), 'only on main\n');
  const mainOnly = commitAll(clone, 'Change main');
  git(clone, 'push', '--quiet', bare, 'HEAD:refs/heads/main');
  git(clone, 'checkout', '--quiet', branch);
  git(clone, 'branch', '--quiet', '-D', 'main-work');

  writeFileSync(join(clone, 'src', 'app.ts'), 'export const a = 2;\n');
  writeFileSync(join(clone, 'assets', 'data.zip'), ZIP_V2);
  writeFileSync(join(clone, 'long.txt'), lines(120, 'new'));
  git(clone, 'mv', 'moved/before.txt', 'moved/after.txt');
  writeFileSync(
    join(clone, 'moved', 'after.txt'),
    lines(10, 'line').replace('line 9', 'line nine'),
  );
  const head = commitAll(clone, 'Change the branch');
  await ctx.request({ method: 'POST', url: `/api/issues/${issueKey}/workspace/sync`, payload: {} });

  const tree = git(clone, 'rev-parse', 'HEAD^{tree}');
  const dangling = git(bare, 'commit-tree', tree, '-p', head, '-m', 'unreachable');

  return {
    ctx,
    workspace,
    projectId,
    branch,
    base,
    mainOnly,
    head,
    dangling,
    cookies,
    get: (url, role = 'viewer', headers = {}) =>
      asBrowser(ctx, cookies[role], { method: 'GET', url, headers }),
    cleanup: async () => {
      await ctx.close();
      root.cleanup();
    },
  };
}
