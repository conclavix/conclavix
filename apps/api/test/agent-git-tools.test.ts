import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentDoc, IssueDoc } from '../src/db.js';
import { GIT_TOOL_NAMES } from '../src/modules/agent-api/git-tools.js';
import type { OrgPosition } from '../src/modules/org/position.js';
import { Workspace } from '../src/modules/workspace/service.js';
import { GIT_INTEGRATION_HINT, buildPrompt } from '../src/runner/prompt.js';
import { createTestContext, type TestContext } from './helpers.js';
import { callTool, connectAgent, startRunFor, type ToolCall } from './mcp-helpers.js';
import { createFixture, type Fixture } from './scheduler-helpers.js';
import { commitAll, git, tempRoot } from './workspace-helpers.js';

type Data = Record<string, unknown>;

/** A tool call that may also be refused before the tool runs (validation, unknown tool). */
async function attempt(client: Client, name: string, args: Data): Promise<ToolCall> {
  try {
    return await callTool(client, name, args);
  } catch (error) {
    return { isError: true, data: { error: String(error) } };
  }
}

describe('agent git integration tools', () => {
  let ctx: TestContext;
  let fx: Fixture;
  let other: Fixture;
  let root: { dir: string; cleanup: () => void };
  let workspace: Workspace;
  let baseUrl: string;
  let integrator: { id: string };
  let engineer: { id: string };
  let own: { id: string; key: string };
  let assigned: { id: string; key: string };
  let foreign: { id: string; key: string };
  let otherProject: { id: string; key: string };
  let client: Client;
  let plain: Client;
  let counter = 0;

  /** Commit `files` on top of `from` in a project's bare repository and push it to `target`. */
  function pushTo(projectId: string, from: string, target: string, files: Record<string, string>) {
    counter += 1;
    const dir = join(root.dir, `helper-${counter}`);
    git(root.dir, 'clone', '--quiet', '--branch', from, workspace.repoDir(projectId), dir);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    commitAll(dir, `change ${target}`);
    git(dir, 'push', '--quiet', 'origin', `HEAD:refs/heads/${target}`);
    return git(dir, 'rev-parse', 'HEAD');
  }

  const bare = (projectId: string, ...args: string[]) =>
    git(root.dir, `--git-dir=${workspace.repoDir(projectId)}`, ...args);
  const refs = (projectId: string) =>
    bare(projectId, 'for-each-ref', '--format=%(refname) %(objectname)');
  const audit = (action: string) =>
    ctx.database.collections.audit.find({ action }).sort({ _id: 1 }).toArray();

  beforeAll(async () => {
    root = tempRoot('cvx-git-tools-');
    workspace = new Workspace(join(root.dir, 'ws'), {
      agentEmailDomain: 'users.noreply.example.com',
    });
    ctx = await createTestContext({ workspace });
    baseUrl = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    fx = await createFixture(ctx);
    other = await createFixture(ctx);
    const lead = await fx.agent({ role: 'ceo' });
    integrator = await fx.agent({
      name: 'Integrator',
      reportsTo: lead.id,
      gitIntegration: true,
    });
    engineer = await fx.agent({ name: 'Engineer', reportsTo: lead.id });
    own = await fx.issue({ title: 'Integrate', assigneeAgentId: integrator.id });
    assigned = await fx.issue({ title: 'Second integration', assigneeAgentId: integrator.id });
    foreign = await fx.issue({ title: 'Somebody else', assigneeAgentId: engineer.id });
    otherProject = await other.issue({ title: 'Elsewhere' });

    await workspace.ensureRepo(fx.projectId);
    await workspace.ensureRepo(other.projectId);
    pushTo(fx.projectId, 'main', 'main', { 'shared.txt': 'one\n' });
    pushTo(fx.projectId, 'main', 'cvx/APP-10', { 'ten.txt': 'ten\n' });
    pushTo(fx.projectId, 'main', 'cvx/APP-11', { 'shared.txt': 'eleven\n' });
    pushTo(fx.projectId, 'main', 'cvx/APP-12', { 'shared.txt': 'twelve\n' });
    pushTo(other.projectId, 'main', 'secret', { 'secret.txt': 'other project\n' });

    client = await connectAgent(baseUrl, (await startRunFor(ctx, fx, own.id)).token);
    plain = await connectAgent(baseUrl, (await startRunFor(ctx, fx, foreign.id)).token);
  });

  afterAll(async () => {
    await client?.close();
    await plain?.close();
    await ctx?.close();
    root?.cleanup();
  });

  it('offers the tools only to agents with the permission', async () => {
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of GIT_TOOL_NAMES) expect(tools).toContain(name);
    const plainTools = (await plain.listTools()).tools.map((tool) => tool.name);
    for (const name of GIT_TOOL_NAMES) expect(plainTools).not.toContain(name);
    const before = refs(fx.projectId);
    const denied = await attempt(plain, 'merge_branches', {
      target: `cvx/${foreign.key}`,
      sources: ['cvx/APP-10'],
    });
    expect(denied.isError).toBe(true);
    expect(refs(fx.projectId)).toBe(before);
  });

  it('merges into the own issue branch as the agent and audits it', async () => {
    const result = await callTool(client, 'merge_branches', {
      target: `cvx/${own.key}`,
      sources: ['cvx/APP-10', 'cvx/APP-11'],
      message: 'Integrate APP-10 and APP-11',
    });
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({ status: 'merged', created: true });
    expect(String(result.data['workingCopy'])).toContain('next run');
    const after = result.data['after'] as string;
    expect(bare(fx.projectId, 'rev-parse', `cvx/${own.key}`)).toBe(after);
    expect(bare(fx.projectId, 'log', '-1', '--format=%an <%ae>%n%B', after)).toContain(
      `Conclavix Integrator <agent-${integrator.id}@users.noreply.example.com>`,
    );
    expect(bare(fx.projectId, 'log', '-1', '--format=%B', after)).toContain(
      `Conclavix-Issue: ${own.key}`,
    );
    const entries = await audit('branch.merged');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actor).toEqual({
      type: 'agent',
      agentId: integrator.id,
      name: 'Integrator',
    });
    expect(entries[0]?.details).toMatchObject({
      projectId: fx.projectId,
      issueKey: own.key,
      target: `cvx/${own.key}`,
      before: null,
      after,
      sources: ['cvx/APP-10', 'cvx/APP-11'],
    });
  });

  it('reports conflicts with their files and changes nothing', async () => {
    const before = refs(fx.projectId);
    const result = await callTool(client, 'merge_branches', {
      target: `cvx/${own.key}`,
      sources: ['cvx/APP-12'],
    });
    expect(result.isError).toBe(true);
    expect(result.data['details']).toMatchObject({
      source: 'cvx/APP-12',
      conflicts: [{ path: 'shared.txt', kinds: ['contents'] }],
    });
    expect(refs(fx.projectId)).toBe(before);
    expect(await audit('branch.merged')).toHaveLength(1);

    const preview = await callTool(client, 'get_merge_status', {
      target: `cvx/${own.key}`,
      sources: ['cvx/APP-10', 'cvx/APP-12'],
    });
    expect(preview.isError).toBe(false);
    const sources = preview.data['sources'] as Data[];
    expect(sources.map((source) => source['contained'])).toEqual([true, false]);
    expect(preview.data['canFastForwardMain']).toBe(true);
  });

  it('merges into a branch of another issue assigned to the agent', async () => {
    const result = await callTool(client, 'merge_branches', {
      target: `cvx/${assigned.key}`,
      sources: ['cvx/APP-10'],
    });
    expect(result.isError).toBe(false);
    expect(String(result.data['workingCopy'])).toContain('next run on that issue');
  });

  it('rejects targets outside the rule and sources outside the project', async () => {
    const before = refs(fx.projectId);
    const cases: [Data, RegExp][] = [
      [{ target: `cvx/${foreign.key}`, sources: ['cvx/APP-10'] }, /not assigned to you/],
      [
        { target: `cvx/${otherProject.key}`, sources: ['cvx/APP-10'] },
        /not the branch of an issue/,
      ],
      [{ target: 'cvx/NOPE-1', sources: ['cvx/APP-10'] }, /not the branch of an issue/],
      [{ target: 'main', sources: ['cvx/APP-10'] }, /issue branch/],
      [{ target: `cvx/${own.key}`, sources: ['secret'] }, /not found/i],
      [{ target: `cvx/${own.key}`, sources: [`cvx/${own.key}`] }, /own sources/],
    ];
    for (const [args, message] of cases) {
      const result = await attempt(client, 'merge_branches', args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(JSON.stringify(result.data), JSON.stringify(args)).toMatch(message);
    }
    expect(refs(fx.projectId)).toBe(before);
    expect(refs(other.projectId)).not.toContain(own.key);
  });

  it('fast-forwards main only, and audits it', async () => {
    const target = bare(fx.projectId, 'rev-parse', `cvx/${own.key}`);
    const result = await callTool(client, 'fast_forward_main', { source: `cvx/${own.key}` });
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({ status: 'fast_forwarded', after: target });
    expect(bare(fx.projectId, 'rev-parse', 'main')).toBe(target);
    const entries = await audit('branch.main_fast_forwarded');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.details).toMatchObject({ branch: 'main', source: `cvx/${own.key}` });

    pushTo(fx.projectId, 'main', 'main', { 'hotfix.txt': 'fix\n' });
    const main = bare(fx.projectId, 'rev-parse', 'main');
    const refused = await callTool(client, 'fast_forward_main', { source: `cvx/${assigned.key}` });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.data)).toMatch(/does not contain main/);
    expect(bare(fx.projectId, 'rev-parse', 'main')).toBe(main);
    expect(await audit('branch.main_fast_forwarded')).toHaveLength(1);
    const notIssue = await attempt(client, 'fast_forward_main', { source: 'cvx/APP-10' });
    expect(notIssue.isError).toBe(true);
  });

  it('refuses once the permission is revoked during the run', async () => {
    await ctx.request({
      method: 'PATCH',
      url: `/api/agents/${integrator.id}`,
      payload: { gitIntegration: false },
    });
    const before = refs(fx.projectId);
    const result = await attempt(client, 'merge_branches', {
      target: `cvx/${assigned.key}`,
      sources: ['cvx/APP-12'],
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.data)).toMatch(/not found|may not integrate branches/);
    expect(refs(fx.projectId)).toBe(before);
    await ctx.request({
      method: 'PATCH',
      url: `/api/agents/${integrator.id}`,
      payload: { gitIntegration: true },
    });
    const changes = await audit('agent.git_integration_changed');
    expect(changes.map((entry) => [entry.details['from'], entry.details['to']])).toEqual([
      ['false', 'true'],
      ['true', 'false'],
      ['false', 'true'],
    ]);
  });

  it('tells agents with the permission about the tools in the run prompt', () => {
    const position: OrgPosition = {
      isLead: false,
      delegators: [],
      delegates: [],
      delegatesNotInProject: [],
      reportsTo: [],
      notifications: [],
    };
    const agent = { _id: new ObjectId(), name: 'Integrator', role: 'engineer' } as AgentDoc;
    const issue = { key: 'APP-17', title: 'Integrate' } as IssueDoc;
    const withGit = buildPrompt(agent, issue, 'assigned', position, { git: true });
    expect(withGit).toContain(GIT_INTEGRATION_HINT[0]);
    expect(buildPrompt(agent, issue, 'assigned', position)).not.toContain('merge_branches');
  });
});
