import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Workspace } from '../src/modules/workspace/service.js';
import { createTestContext, type TestContext } from './helpers.js';
import { callTool, connectAgent, startRunFor, type ToolCall } from './mcp-helpers.js';
import { createFixture, type Fixture } from './scheduler-helpers.js';
import { commitAll, git, tempRoot } from './workspace-helpers.js';

type Data = Record<string, unknown>;

async function attempt(client: Client, name: string, args: Data): Promise<ToolCall> {
  try {
    return await callTool(client, name, args);
  } catch (error) {
    return { isError: true, data: { error: String(error) } };
  }
}

describe('set_branch and commit ids in the git integration tools', () => {
  let ctx: TestContext;
  let fx: Fixture;
  let root: { dir: string; cleanup: () => void };
  let workspace: Workspace;
  let integrator: { id: string };
  let planning: { id: string; key: string };
  let own: { id: string; key: string };
  let sibling: { id: string; key: string };
  let child: { id: string; key: string };
  let child2: { id: string; key: string };
  let foreign: { id: string; key: string };
  let client: Client;
  let counter = 0;
  const commits: Record<string, string> = {};

  function pushTo(from: string, target: string, files: Record<string, string>): string {
    counter += 1;
    const dir = join(root.dir, `helper-${counter}`);
    git(root.dir, 'clone', '--quiet', '--branch', from, workspace.repoDir(fx.projectId), dir);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    commitAll(dir, `change ${target}`);
    git(dir, 'push', '--quiet', 'origin', `HEAD:refs/heads/${target}`);
    return git(dir, 'rev-parse', 'HEAD');
  }

  const bare = (...args: string[]) =>
    git(root.dir, `--git-dir=${workspace.repoDir(fx.projectId)}`, ...args);
  const tip = (branch: string) => {
    try {
      return bare('rev-parse', '--verify', '--quiet', branch);
    } catch {
      return '';
    }
  };
  const refs = () => bare('for-each-ref', '--format=%(refname) %(objectname)');
  const audit = (action: string) =>
    ctx.database.collections.audit.find({ action }).sort({ _id: 1 }).toArray();
  const setBranch = (args: Data) => attempt(client, 'set_branch', args);

  beforeAll(async () => {
    root = tempRoot('cvx-set-branch-');
    workspace = new Workspace(join(root.dir, 'ws'));
    ctx = await createTestContext({ workspace });
    const baseUrl = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    fx = await createFixture(ctx);
    const lead = await fx.agent({ role: 'ceo' });
    integrator = await fx.agent({ name: 'Integrator', reportsTo: lead.id, gitIntegration: true });
    const engineer = await fx.agent({ name: 'Engineer', reportsTo: lead.id });
    planning = await fx.issue({ title: 'Release', assigneeAgentId: lead.id });
    own = await fx.issue({
      title: 'Integrate',
      assigneeAgentId: integrator.id,
      parentId: planning.id,
    });
    sibling = await fx.issue({
      title: 'Build',
      assigneeAgentId: engineer.id,
      parentId: planning.id,
    });
    child = await fx.issue({ title: 'Below', assigneeAgentId: engineer.id, parentId: own.id });
    child2 = await fx.issue({ title: 'Below too', assigneeAgentId: engineer.id, parentId: own.id });
    foreign = await fx.issue({ title: 'Elsewhere', assigneeAgentId: engineer.id });
    // The lead handed the integration out from its release issue, as create_subissue does.
    await ctx.database.collections.issues.updateOne(
      { _id: new ObjectId(own.id) },
      {
        $set: {
          delegatedBy: new ObjectId(lead.id),
          delegatedFromIssueId: new ObjectId(planning.id),
        },
      },
    );

    await workspace.ensureRepo(fx.projectId);
    commits['c1'] = pushTo('main', 'main', { 'shared.txt': 'one\n' });
    commits['f1'] = pushTo('main', 'feature', { 'f.txt': 'f1\n' });
    commits['f2'] = pushTo('feature', 'feature', { 'f.txt': 'f2\n' });
    client = await connectAgent(baseUrl, (await startRunFor(ctx, fx, own.id)).token);
  });

  afterAll(async () => {
    await client?.close();
    await ctx?.close();
    root?.cleanup();
  });

  const branchOf = (issue: { key: string }) => `cvx/${issue.key}`;

  it('creates a missing issue branch at an abbreviated commit id and audits it', async () => {
    const result = await setBranch({
      branch: branchOf(sibling),
      commit: commits['f1']?.slice(0, 7),
    });
    expect(result.isError, JSON.stringify(result.data)).toBe(false);
    expect(result.data).toMatchObject({ status: 'created', before: null, after: commits['f1'] });
    expect(tip(branchOf(sibling))).toBe(commits['f1']);
    const entries = await audit('branch.set');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actor).toMatchObject({ type: 'agent', agentId: integrator.id });
    expect(entries[0]?.details).toMatchObject({
      branch: branchOf(sibling),
      status: 'created',
      after: commits['f1'],
    });
  });

  it('moves forward, refuses a rewind and rewinds with a backup when allowed', async () => {
    const forward = await setBranch({ branch: branchOf(sibling), commit: 'feature' });
    expect(forward.data).toMatchObject({ status: 'fast_forwarded', commits: 1 });
    expect(tip(branchOf(sibling))).toBe(commits['f2']);

    const before = refs();
    const refused = await setBranch({ branch: branchOf(sibling), commit: commits['c1'] });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.data)).toMatch(/not_fast_forward|allowRewind/);
    expect(refs()).toBe(before);

    const rewound = await setBranch({
      branch: branchOf(sibling),
      commit: commits['c1'],
      allowRewind: true,
    });
    expect(rewound.data).toMatchObject({ status: 'rewound', dropped: 2, after: commits['c1'] });
    const backupRef = String(rewound.data['backupRef']);
    expect(backupRef).toMatch(
      new RegExp(`^refs/backup/cvx/${sibling.key}/\\d{8}T\\d{6}Z-${commits['f2']?.slice(0, 12)}$`),
    );
    expect(tip(backupRef)).toBe(commits['f2']);
    expect(tip(branchOf(sibling))).toBe(commits['c1']);
    expect((await audit('branch.set')).at(-1)?.details).toMatchObject({
      status: 'rewound',
      backupRef,
      before: commits['f2'],
    });

    // Restoring the old head is a fast-forward again.
    const restored = await setBranch({ branch: branchOf(sibling), commit: commits['f2'] });
    expect(restored.data).toMatchObject({ status: 'fast_forwarded', after: commits['f2'] });
  });

  it('refuses main, unknown, foreign and unreachable commits', async () => {
    const dangling = bare('commit-tree', `${commits['c1']}^{tree}`, '-m', 'unreferenced');
    const before = refs();
    const cases: [Data, RegExp][] = [
      [{ branch: 'main', commit: commits['f2'] }, /issue branch/],
      [{ branch: branchOf(child), commit: 'deadbeefdead' }, /not found/i],
      [{ branch: branchOf(child), commit: 'a'.repeat(40) }, /not found/i],
      [{ branch: branchOf(child), commit: dangling }, /not found/i],
      [{ branch: branchOf(child), commit: 'no-such-branch' }, /not found/i],
    ];
    for (const [args, message] of cases) {
      const result = await setBranch(args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(JSON.stringify(result.data), JSON.stringify(args)).toMatch(message);
    }
    expect(refs()).toBe(before);
  });

  it('keeps to the branch scope: own tree, assigned issues and delegated siblings', async () => {
    const below = await setBranch({ branch: branchOf(child), commit: commits['c1'] });
    expect(below.isError, JSON.stringify(below.data)).toBe(false);
    const before = refs();
    for (const issue of [foreign, planning]) {
      const result = await setBranch({ branch: branchOf(issue), commit: commits['c1'] });
      expect(result.isError, issue.key).toBe(true);
      expect(JSON.stringify(result.data)).toMatch(/not assigned to you/);
    }
    const merge = await attempt(client, 'merge_branches', {
      target: branchOf(foreign),
      sources: ['feature'],
    });
    expect(merge.isError).toBe(true);
    expect(refs()).toBe(before);
  });

  it('creates a merge target from a commit id given as base', async () => {
    const merged = await callTool(client, 'merge_branches', {
      target: branchOf(child2),
      sources: ['feature'],
      base: commits['c1']?.slice(0, 8),
    });
    expect(merged.isError, JSON.stringify(merged.data)).toBe(false);
    expect(merged.data).toMatchObject({
      created: true,
      startedFrom: { sha: commits['c1'] },
    });
    const dangling = bare('commit-tree', `${commits['c1']}^{tree}`, '-m', 'unreferenced base');
    const refused = await attempt(client, 'merge_branches', {
      target: 'cvx/' + own.key,
      sources: ['feature'],
      base: dangling,
    });
    expect(refused.isError).toBe(true);
    expect(tip(branchOf(own))).toBe('');
  });

  it('fast-forwards main to an exact commit id that lies on an issue branch', async () => {
    const result = await callTool(client, 'fast_forward_main', { source: commits['f1'] });
    expect(result.isError, JSON.stringify(result.data)).toBe(false);
    expect(result.data).toMatchObject({ status: 'fast_forwarded', after: commits['f1'] });
    expect(tip('main')).toBe(commits['f1']);
    expect((await audit('branch.main_fast_forwarded')).at(-1)?.details).toMatchObject({
      source: commits['f1'],
    });

    // A commit only on a non-issue branch is not releasable this way.
    const f3 = pushTo('feature', 'feature', { 'f.txt': 'f3\n' });
    const refused = await attempt(client, 'fast_forward_main', { source: f3 });
    expect(refused.isError).toBe(true);
    expect(tip('main')).toBe(commits['f1']);
  });

  it('refuses set_branch once the permission is revoked', async () => {
    await ctx.request({
      method: 'PATCH',
      url: `/api/agents/${integrator.id}`,
      payload: { gitIntegration: false },
    });
    const before = refs();
    const result = await setBranch({ branch: branchOf(child), commit: 'feature' });
    expect(result.isError).toBe(true);
    expect(refs()).toBe(before);
  });
});
