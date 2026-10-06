import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentDoc, IssueDoc } from '../src/db.js';
import { CODE_TOOL_LIMITS, CODE_TOOL_NAMES } from '../src/modules/agent-api/code-tools.js';
import type { OrgPosition } from '../src/modules/org/position.js';
import { Workspace } from '../src/modules/workspace/service.js';
import { buildPrompt } from '../src/runner/prompt.js';
import { createTestContext, type TestContext } from './helpers.js';
import { callTool, connectAgent, startRunFor, type ToolCall } from './mcp-helpers.js';
import { createFixture, type Fixture } from './scheduler-helpers.js';
import { commitAll, git, tempRoot } from './workspace-helpers.js';

type Data = Record<string, unknown>;
type DiffFile = {
  path: string;
  status: string;
  binary: boolean;
  patch?: string | null;
  patchTruncated?: boolean;
};

/** A tool call that may also be refused by input validation before the tool runs. */
async function attempt(client: Client, name: string, args: Data): Promise<ToolCall> {
  try {
    return await callTool(client, name, args);
  } catch (error) {
    return { isError: true, data: { error: String(error) } };
  }
}

/** Lines `line 1` to `line <count>`. */
const numbered = (count: number, prefix = 'line'): string =>
  Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';

describe('agent code tools', () => {
  let ctx: TestContext;
  let fx: Fixture;
  let other: Fixture;
  let root: { dir: string; cleanup: () => void };
  let workspace: Workspace;
  let baseUrl: string;
  let engineer: { id: string };
  let issue: { id: string; key: string };
  let branch: string;
  let mainSha: string;
  let client: Client;

  /** Clone a project's bare repository, let `work` change it, push HEAD to `target`. */
  function pushTo(projectId: string, from: string, target: string, work: (dir: string) => void) {
    const dir = join(root.dir, `clone-${new ObjectId().toHexString()}`);
    git(root.dir, 'clone', '--quiet', '--branch', from, workspace.repoDir(projectId), dir);
    work(dir);
    git(dir, 'push', '--quiet', 'origin', `HEAD:refs/heads/${target}`);
    return git(dir, 'rev-parse', 'HEAD');
  }

  const write = (dir: string, path: string, content: string | Buffer) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  };

  beforeAll(async () => {
    root = tempRoot('cvx-code-tools-');
    workspace = new Workspace(join(root.dir, 'ws'));
    ctx = await createTestContext({ workspace });
    baseUrl = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    fx = await createFixture(ctx);
    other = await createFixture(ctx);
    const lead = await fx.agent({ role: 'ceo' });
    engineer = await fx.agent({ reportsTo: lead.id });
    issue = await fx.issue({ title: 'Review the login', assigneeAgentId: engineer.id });
    branch = `cvx/${issue.key}`;

    mainSha = pushTo(fx.projectId, 'main', 'main', (dir) => {
      write(dir, 'README.md', '# Demo\n');
      write(dir, 'src/app.ts', numbered(30));
      for (let i = 0; i < 3; i += 1) write(dir, `src/lib/m${i}.ts`, `export const m${i} = ${i};\n`);
      commitAll(dir, 'Add the app');
    });
    pushTo(fx.projectId, 'main', branch, (dir) => {
      write(dir, 'src/app.ts', numbered(30).replace('line 5\n', 'line five\n'));
      write(dir, 'assets/logo.bin', Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02, 0x00]));
      commitAll(dir, 'Change line five, add a logo');
      for (let i = 0; i < 4; i += 1) {
        write(dir, `big/f${i}.txt`, numbered(3000, `big ${i}`));
      }
      write(dir, 'docs/notes.md', 'notes\n');
      write(dir, 'huge.txt', 'x'.repeat(1024 * 1024 + 10));
      commitAll(dir, 'Add big files');
    });
    pushTo(other.projectId, 'main', 'secret-branch', (dir) => {
      write(dir, 'secret.txt', 'other project only\n');
      commitAll(dir, 'Other project');
    });

    const { token } = await startRunFor(ctx, fx, issue.id);
    client = await connectAgent(baseUrl, token);
  });

  afterAll(async () => {
    await client?.close();
    await ctx?.close();
    root?.cleanup();
  });

  it('offers the code tools to every agent when a workspace is configured', async () => {
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of CODE_TOOL_NAMES) expect(tools).toContain(name);
  });

  it('lists branches with ahead/behind against main, paginated', async () => {
    const all = await callTool(client, 'list_branches');
    expect(all.isError).toBe(false);
    const items = all.data['items'] as Data[];
    expect(items.map((item) => item['name'])).toEqual(['main', branch]);
    expect(items[1]).toMatchObject({ ahead: 2, behind: 0, issueKey: issue.key, isDefault: false });
    expect((items[1]?.['lastCommit'] as Data)['subject']).toBe('Add big files');

    const first = await callTool(client, 'list_branches', { limit: 1 });
    expect(first.data).toMatchObject({ total: 2, nextOffset: 1 });
    const second = await callTool(client, 'list_branches', { offset: 1, limit: 1 });
    expect(second.data).toMatchObject({ nextOffset: null });
    expect((second.data['items'] as Data[])[0]?.['name']).toBe(branch);
  });

  it('diffs a branch against main per file, with binary files and size limits', async () => {
    const diff = await callTool(client, 'get_branch_diff', { branch, limit: 50 });
    expect(diff.isError).toBe(false);
    expect(diff.data).toMatchObject({ base: 'main', branch, ahead: 2, behind: 0, totalFiles: 8 });
    expect(diff.data['mergeBase']).toBe(mainSha);
    const commits = diff.data['commits'] as Data[];
    expect(commits.map((commit) => commit['subject'])).toEqual([
      'Add big files',
      'Change line five, add a logo',
    ]);

    const files = diff.data['files'] as DiffFile[];
    const byPath = new Map(files.map((file) => [file.path, file]));
    expect(byPath.get('assets/logo.bin')).toMatchObject({ binary: true, patch: null });

    const big = files.find((file) => file.path.startsWith('big/'));
    expect(big?.patchTruncated).toBe(true);
    expect(big?.patch).toContain('[conclavix: patch cut at');
    expect(Buffer.byteLength(big?.patch ?? '')).toBeLessThan(
      CODE_TOOL_LIMITS.maxFilePatchBytes + 200,
    );

    const pageBytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.patch ?? ''), 0);
    expect(pageBytes).toBeLessThanOrEqual(CODE_TOOL_LIMITS.maxPagePatchBytes);
    expect(files.length).toBeLessThan(8);
    expect(diff.data['nextOffset']).toBe(files.length);

    const rest = await callTool(client, 'get_branch_diff', {
      branch,
      offset: diff.data['nextOffset'],
      limit: 50,
    });
    const restFiles = rest.data['files'] as DiffFile[];
    expect(restFiles[0]?.path).not.toBe(files[files.length - 1]?.path);
  });

  it('lists all changed files without patches and filters by path', async () => {
    const summary = await callTool(client, 'get_branch_diff', {
      branch,
      withPatch: false,
      limit: 300,
    });
    const files = summary.data['files'] as DiffFile[];
    expect(files).toHaveLength(8);
    expect(files.every((file) => file.patch === undefined)).toBe(true);
    expect(summary.data['nextOffset']).toBeNull();

    const filtered = await callTool(client, 'get_branch_diff', {
      branch,
      paths: ['src', 'docs/notes.md'],
    });
    expect((filtered.data['files'] as DiffFile[]).map((file) => file.path).sort()).toEqual([
      'docs/notes.md',
      'src/app.ts',
    ]);
    const app = (filtered.data['files'] as DiffFile[]).find((file) => file.path === 'src/app.ts');
    expect(app?.status).toBe('modified');
    expect(app?.patch).toContain('-line 5\n+line five');

    const tooMany = await callTool(client, 'get_branch_diff', { branch, limit: 100 });
    expect(tooMany.isError).toBe(true);
    expect(tooMany.data.error).toMatch(/withPatch=false/);
  });

  it('compares against another base ref', async () => {
    const firstCommit = git(workspace.repoDir(fx.projectId), 'rev-parse', `${branch}~1`);
    const diff = await callTool(client, 'get_branch_diff', {
      branch,
      base: firstCommit,
      withPatch: false,
      limit: 300,
    });
    expect(diff.data).toMatchObject({ ahead: 1, totalFiles: 6, mergeBase: firstCommit });
  });

  it('reads files by line range, refusing binary and oversized content', async () => {
    const window = await callTool(client, 'read_file', {
      path: 'src/app.ts',
      ref: branch,
      startLine: 4,
      maxLines: 3,
    });
    expect(window.data).toMatchObject({
      content: 'line 4\nline five\nline 6',
      startLine: 4,
      endLine: 6,
      totalLines: 30,
      nextStartLine: 7,
    });

    const onMain = await callTool(client, 'read_file', { path: 'src/app.ts' });
    expect(onMain.data).toMatchObject({
      ref: 'main',
      sha: mainSha,
      endLine: 30,
      nextStartLine: null,
    });

    const big = await callTool(client, 'read_file', {
      path: 'big/f0.txt',
      ref: branch,
      maxLines: 2000,
    });
    expect(Buffer.byteLength(big.data['content'] as string)).toBeLessThanOrEqual(
      CODE_TOOL_LIMITS.maxFileBytes,
    );
    expect(big.data['nextStartLine']).toBe((big.data['endLine'] as number) + 1);

    const binary = await callTool(client, 'read_file', { path: 'assets/logo.bin', ref: branch });
    expect(binary.data).toMatchObject({ binary: true, content: null });
    const huge = await callTool(client, 'read_file', { path: 'huge.txt', ref: branch });
    expect(huge.data).toMatchObject({ tooLarge: true, content: null });

    const past = await callTool(client, 'read_file', { path: 'README.md', startLine: 5 });
    expect(past.isError).toBe(true);
    const missing = await callTool(client, 'read_file', { path: 'nope.ts' });
    expect(missing.isError).toBe(true);
    expect(missing.data.error).toMatch(/not found/);
  });

  it('lists directories, paginated', async () => {
    const rootDir = await callTool(client, 'list_files', { ref: branch });
    const paths = (rootDir.data['items'] as Data[]).map((entry) => entry['path']);
    expect(paths).toEqual(expect.arrayContaining(['README.md', 'src', 'big', 'assets']));

    const lib = await callTool(client, 'list_files', { path: 'src/lib', limit: 2 });
    expect(lib.data).toMatchObject({ path: 'src/lib', total: 3, nextOffset: 2 });
    expect((lib.data['items'] as Data[])[0]).toMatchObject({ path: 'src/lib/m0.ts', type: 'blob' });

    const notDir = await callTool(client, 'list_files', { path: 'README.md' });
    expect(notDir.isError).toBe(true);
  });

  it('pages through the commit log', async () => {
    const first = await callTool(client, 'get_commit_log', { ref: branch, limit: 2 });
    expect((first.data['items'] as Data[]).map((commit) => commit['subject'])).toEqual([
      'Add big files',
      'Change line five, add a logo',
    ]);
    expect(first.data['nextSkip']).toBe(2);
    const rest = await callTool(client, 'get_commit_log', { ref: branch, skip: 2, limit: 50 });
    expect((rest.data['items'] as Data[]).map((commit) => commit['subject'])).toEqual([
      'Add the app',
      'Initialize repository',
    ]);
    expect(rest.data['nextSkip']).toBeNull();
  });

  it('reads only the project of the run', async () => {
    const foreign = await callTool(client, 'read_file', {
      path: 'secret.txt',
      ref: 'secret-branch',
    });
    expect(foreign.isError).toBe(true);
    const branches = await attempt(client, 'list_branches', { projectId: other.projectId });
    const names = ((branches.data['items'] as Data[] | undefined) ?? []).map((b) => b['name']);
    expect(names).not.toContain('secret-branch');
  });

  it('refuses refs and paths outside the validated forms', async () => {
    const refs = [
      '-x',
      '--output=/tmp/x',
      'main..cvx',
      'a/.hidden',
      'name.lock',
      'HEAD@{1}',
      'a b',
    ];
    for (const ref of refs) {
      const result = await attempt(client, 'get_commit_log', { ref });
      expect(result.isError, ref).toBe(true);
      const diff = await attempt(client, 'get_branch_diff', { branch: ref });
      expect(diff.isError, ref).toBe(true);
    }
    const paths = ['../etc/passwd', '/etc/passwd', 'src/../../x', '-p', 'src//app.ts', './src'];
    for (const path of paths) {
      expect((await attempt(client, 'read_file', { path })).isError, path).toBe(true);
      expect((await attempt(client, 'list_files', { path })).isError, path).toBe(true);
      const diff = await attempt(client, 'get_branch_diff', { branch, paths: [path] });
      expect(diff.isError, path).toBe(true);
    }
  });

  it('refuses agents that are not enabled in the project', async () => {
    const projects = ctx.database.collections.projects;
    const agents = ctx.database.collections.agents;
    const project = { _id: new ObjectId(fx.projectId) };
    const agent = { _id: new ObjectId(engineer.id) };
    const argsFor = (name: string): Data =>
      name === 'get_branch_diff' ? { branch } : name === 'read_file' ? { path: 'README.md' } : {};
    const expectRefused = async () => {
      for (const name of CODE_TOOL_NAMES) {
        const result = await callTool(client, name, argsFor(name));
        expect(result.isError, name).toBe(true);
        expect(result.data.error, name).toMatch(/not enabled in project/);
      }
    };
    try {
      await projects.updateOne(project, {
        $set: { agentOverrides: [{ agentId: agent._id, enabled: false, updatedAt: new Date() }] },
      });
      await expectRefused();
      await projects.updateOne(project, { $set: { agentOverrides: [] } });
      await agents.updateOne(agent, { $set: { projectDefault: 'disabled' } });
      await expectRefused();
    } finally {
      await projects.updateOne(project, { $set: { agentOverrides: [] } });
      await agents.updateOne(agent, { $set: { projectDefault: 'enabled' } });
    }
    expect((await callTool(client, 'list_branches')).isError).toBe(false);
  });
});

describe('run prompt', () => {
  it('tells every agent about the read-only code tools', () => {
    const agent = { name: 'Reviewer', title: '', role: 'reviewer' } as unknown as AgentDoc;
    const issue = { key: 'CVX-1', title: 'Review' } as unknown as IssueDoc;
    const position = {
      isLead: false,
      delegators: [],
      delegates: [],
      delegatesNotInProject: [],
      reportsTo: [],
      notifications: [],
    } as unknown as OrgPosition;
    const prompt = buildPrompt(agent, issue, 'assigned', position);
    for (const name of CODE_TOOL_NAMES) expect(prompt).toContain(name);
    expect(prompt).toContain('read-only');
  });
});
