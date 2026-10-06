import { ObjectId } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';
import { asBrowser, createUser, signIn } from './auth-helpers.js';
import { callTool, connectAgent, startRunFor } from './mcp-helpers.js';
import { createFixture, type Fixture } from './scheduler-helpers.js';

interface ProjectAgentRow {
  id: string;
  name: string;
  enabled: boolean;
  source: 'default' | 'project';
  override: boolean | null;
  projectDefault: 'enabled' | 'disabled';
  isLead: boolean;
  openIssues: number;
}

describe('per-project agent access', () => {
  let ctx: TestContext;
  let fx: Fixture;
  let lead: { id: string };
  let dev: { id: string };
  let reviewer: { id: string };

  const listAgents = async (projectId = fx.projectId): Promise<ProjectAgentRow[]> => {
    const response = await ctx.request({ method: 'GET', url: `/api/projects/${projectId}/agents` });
    expect(response.statusCode).toBe(200);
    return response.json().items;
  };
  const row = async (agentId: string, projectId = fx.projectId) =>
    (await listAgents(projectId)).find((item) => item.id === agentId);
  const setAccess = (agentId: string, enabled: boolean | null, projectId = fx.projectId) =>
    ctx.request({
      method: 'PUT',
      url: `/api/projects/${projectId}/agents/${agentId}`,
      payload: { enabled },
    });
  const createProject = async (key: string): Promise<string> =>
    (
      await ctx.request({
        method: 'POST',
        url: '/api/projects',
        payload: { key, name: key, autoPlan: false },
      })
    ).json().id;

  beforeEach(async () => {
    ctx = await createTestContext({ settingsDefaults: { mfaPolicy: 'optional' } });
    fx = await createFixture(ctx);
    lead = await fx.agent({ name: 'CEO', role: 'ceo' });
    dev = await fx.agent({ name: 'Dev', role: 'engineer', reportsTo: lead.id });
    reviewer = await fx.agent({
      name: 'Reviewer',
      role: 'reviewer',
      reportsTo: lead.id,
      projectDefault: 'disabled',
    });
    const set = await ctx.request({
      method: 'PUT',
      url: '/api/org/lead',
      payload: { agentId: lead.id },
    });
    expect(set.statusCode).toBe(200);
  });

  afterEach(async () => {
    await ctx.close();
  });

  describe('effective state', () => {
    it('resolves override before agent default and lists the lead first', async () => {
      const items = await listAgents();
      expect(items.map((item) => item.name)).toEqual(['CEO', 'Dev', 'Reviewer']);
      expect(items[0]).toMatchObject({ isLead: true, enabled: true, source: 'default' });
      expect(items[1]).toMatchObject({ enabled: true, source: 'default', override: null });
      expect(items[2]).toMatchObject({
        enabled: false,
        source: 'default',
        projectDefault: 'disabled',
      });

      const enabled = await setAccess(reviewer.id, true);
      expect(enabled.statusCode).toBe(200);
      expect(enabled.json()).toMatchObject({ enabled: true, source: 'project', override: true });
      const disabled = await setAccess(dev.id, false);
      expect(disabled.json()).toMatchObject({ enabled: false, source: 'project', override: false });

      const other = await createProject('OTH');
      expect(await row(reviewer.id, other)).toMatchObject({ enabled: false, source: 'default' });
      expect(await row(dev.id, other)).toMatchObject({ enabled: true, source: 'default' });

      const reset = await setAccess(reviewer.id, null);
      expect(reset.json()).toMatchObject({ enabled: false, source: 'default', override: null });
      const project = await ctx.database.collections.projects.findOne({
        _id: new ObjectId(fx.projectId),
      });
      expect(project?.agentOverrides).toHaveLength(1);
    });

    it('treats agents stored without a project default as enabled', async () => {
      await ctx.database.collections.agents.updateOne(
        { _id: new ObjectId(dev.id) },
        { $unset: { projectDefault: '' } },
      );
      expect(await row(dev.id)).toMatchObject({ enabled: true, projectDefault: 'enabled' });
      const agent = await ctx.request({ method: 'GET', url: `/api/agents/${dev.id}` });
      expect(agent.json().projectDefault).toBe('enabled');
    });

    it('counts open issues per agent in the project', async () => {
      await fx.issue({ title: 'one', assigneeAgentId: dev.id });
      const closed = await fx.issue({ title: 'two', assigneeAgentId: dev.id });
      await fx.patch(closed.key, { status: 'cancelled' });
      expect(await row(dev.id)).toMatchObject({ openIssues: 1 });
      const response = await setAccess(dev.id, false);
      expect(response.json()).toMatchObject({ enabled: false, openIssues: 1 });
    });

    it('validates ids and bodies', async () => {
      expect((await setAccess(new ObjectId().toHexString(), true)).statusCode).toBe(404);
      expect((await setAccess(dev.id, true, new ObjectId().toHexString())).statusCode).toBe(404);
      const bad = await ctx.request({
        method: 'PUT',
        url: `/api/projects/${fx.projectId}/agents/${dev.id}`,
        payload: { enabled: 'yes' },
      });
      expect(bad.statusCode).toBe(400);
    });

    it('drops the overrides of a deleted agent', async () => {
      await setAccess(dev.id, false);
      expect(
        (await ctx.request({ method: 'DELETE', url: `/api/agents/${dev.id}` })).statusCode,
      ).toBe(204);
      const project = await ctx.database.collections.projects.findOne({
        _id: new ObjectId(fx.projectId),
      });
      expect(project?.agentOverrides).toEqual([]);
    });
  });

  describe('lead lock', () => {
    it('refuses to disable the lead and keeps it enabled after a lead change', async () => {
      const refused = await setAccess(lead.id, false);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toBe('lead_always_enabled');
      expect((await setAccess(lead.id, true)).statusCode).toBe(200);
      const stored = await ctx.database.collections.projects.findOne({
        _id: new ObjectId(fx.projectId),
      });
      expect(stored?.agentOverrides ?? []).toEqual([]);

      await setAccess(reviewer.id, false);
      await ctx.database.collections.org.updateOne(
        { _id: 'org' },
        { $set: { leadAgentId: new ObjectId(reviewer.id) } },
      );
      expect(await row(reviewer.id)).toMatchObject({ isLead: true, enabled: true, override: null });
      const issue = await fx.issue({ title: 'lead work', assigneeAgentId: reviewer.id });
      expect(issue.key).toBeDefined();
    });
  });

  describe('lead change', () => {
    it('drops the overrides of an agent that becomes the lead', async () => {
      const ops = await fx.agent({ name: 'Ops', role: 'ops' });
      await setAccess(ops.id, false);
      const set = await ctx.request({
        method: 'PUT',
        url: '/api/org/lead',
        payload: { agentId: ops.id },
      });
      expect(set.statusCode).toBe(200);
      const project = await ctx.database.collections.projects.findOne({
        _id: new ObjectId(fx.projectId),
      });
      expect(project?.agentOverrides).toEqual([]);
      expect(await row(ops.id)).toMatchObject({ isLead: true, enabled: true, override: null });
    });
  });

  describe('audit', () => {
    it('records override and project default changes', async () => {
      await setAccess(reviewer.id, true);
      expect((await setAccess(reviewer.id, true)).json()).toMatchObject({ enabled: true });
      const patched = await ctx.request({
        method: 'PATCH',
        url: `/api/agents/${dev.id}`,
        payload: { projectDefault: 'disabled' },
      });
      expect(patched.json().projectDefault).toBe('disabled');
      await ctx.request({
        method: 'PATCH',
        url: `/api/agents/${dev.id}`,
        payload: { projectDefault: 'disabled' },
      });
      const entries = await ctx.database.collections.audit
        .find({
          action: { $in: ['project.agent_access_changed', 'agent.project_default_changed'] },
        })
        .sort({ _id: 1 })
        .toArray();
      expect(entries.map((entry) => entry.action)).toEqual([
        'project.agent_access_changed',
        'agent.project_default_changed',
      ]);
      expect(entries[0]?.details).toMatchObject({
        agent: 'Reviewer',
        from: 'default',
        to: 'enabled',
        effective: 'enabled',
        wasEffective: 'disabled',
      });
      expect(entries[1]?.details).toMatchObject({ agent: 'Dev', from: 'enabled', to: 'disabled' });
    });
  });

  describe('REST enforcement', () => {
    it('rejects creating or assigning issues for an agent disabled in the project', async () => {
      const created = await ctx.request({
        method: 'POST',
        url: '/api/issues',
        payload: { projectId: fx.projectId, title: 'review', assigneeAgentId: reviewer.id },
      });
      expect(created.statusCode).toBe(422);
      expect(created.json()).toMatchObject({
        error: 'agent_disabled_in_project',
        details: { agentId: reviewer.id, projectId: fx.projectId },
      });

      const issue = await fx.issue({ title: 'unassigned' });
      const assign = await ctx.request({
        method: 'PATCH',
        url: `/api/issues/${issue.key}`,
        payload: { assigneeAgentId: reviewer.id },
      });
      expect(assign.statusCode).toBe(422);
      expect(assign.json().error).toBe('agent_disabled_in_project');

      await setAccess(reviewer.id, true);
      const allowed = await ctx.request({
        method: 'PATCH',
        url: `/api/issues/${issue.key}`,
        payload: { assigneeAgentId: reviewer.id },
      });
      expect(allowed.statusCode).toBe(200);
    });

    it('keeps existing assignments when an agent is disabled, and allows unassigning', async () => {
      const issue = await fx.issue({ title: 'work', assigneeAgentId: dev.id });
      await setAccess(dev.id, false);
      const same = await ctx.request({
        method: 'PATCH',
        url: `/api/issues/${issue.key}`,
        payload: { assigneeAgentId: dev.id, priority: 'high' },
      });
      expect(same.statusCode).toBe(200);
      expect(same.json().assigneeAgentId).toBe(dev.id);
      const wake = await ctx.request({
        method: 'POST',
        url: `/api/agents/${dev.id}/wake`,
        payload: { issueId: issue.id },
      });
      expect(wake.statusCode).toBe(422);
      expect(wake.json().error).toBe('agent_disabled_in_project');
      const cleared = await ctx.request({
        method: 'PATCH',
        url: `/api/issues/${issue.key}`,
        payload: { assigneeAgentId: null },
      });
      expect(cleared.statusCode).toBe(200);
    });
  });

  describe('scheduler', () => {
    it('skips wakes for disabled agents with a reason and sends no heartbeats', async () => {
      const issue = await fx.issue({ title: 'work', assigneeAgentId: dev.id });
      await setAccess(dev.id, false);
      const counts = await fx.scheduler.processPendingWakes();
      expect(counts).toMatchObject({ run: 0, skip: 1 });
      const wake = await ctx.database.collections.wakes.findOne({
        issueId: new ObjectId(issue.id),
      });
      expect(wake?.skipReason).toBe('agent_disabled_in_project');
      expect(fx.dispatcher.runs).toHaveLength(0);

      expect(await fx.scheduler.sweepHeartbeats()).toBe(0);
      expect(await fx.pendingWakes()).toBe(0);

      await setAccess(dev.id, null);
      expect(await fx.scheduler.sweepHeartbeats()).toBe(1);
      expect(await fx.scheduler.processPendingWakes()).toMatchObject({ run: 1 });
    });

    it('skips heartbeats outside the projects that enable a default-off agent', async () => {
      const other = await createProject('OTH');
      await setAccess(reviewer.id, true);
      await setAccess(reviewer.id, true, other);
      await fx.issue({ title: 'here', assigneeAgentId: reviewer.id });
      const there = (
        await ctx.request({
          method: 'POST',
          url: '/api/issues',
          payload: { projectId: other, title: 'there', assigneeAgentId: reviewer.id },
        })
      ).json();
      await ctx.database.collections.wakes.deleteMany({});
      await setAccess(reviewer.id, null, other);
      expect(await fx.scheduler.sweepHeartbeats()).toBe(1);
      const wakes = await ctx.database.collections.wakes.find().toArray();
      expect(wakes.map((wake) => wake.issueId.toHexString())).not.toContain(there.id);
    });
  });

  describe('agent MCP tools', () => {
    let baseUrl: string;

    beforeEach(async () => {
      baseUrl = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    });

    it('marks disabled agents in list_team and rejects delegating to them', async () => {
      const planning = await fx.issue({ title: 'Plan', assigneeAgentId: lead.id });
      const { token } = await startRunFor(ctx, fx, planning.id);
      const client = await connectAgent(baseUrl, token);

      const team = await callTool(client, 'list_team');
      const names = (list: unknown) => (list as { name: string }[]).map((agent) => agent.name);
      expect(names(team.data['canDelegateTo'])).toEqual(['Dev']);
      expect(names(team.data['notInThisProject'])).toEqual(['Reviewer']);

      const sub = await callTool(client, 'create_subissue', {
        title: 'Review it',
        assigneeAgentId: reviewer.id,
      });
      expect(sub.isError).toBe(true);
      expect(sub.data.error).toContain('not enabled in project');

      const project = await ctx.database.collections.projects.findOne({
        _id: new ObjectId(fx.projectId),
      });
      const key = project?.key ?? '';
      const top = await callTool(client, 'create_issue', {
        projectKey: key,
        title: 'Review all',
        assigneeAgentId: reviewer.id,
      });
      expect(top.isError).toBe(true);
      expect(top.data.error).toContain('not enabled in project');

      const board = await callTool(client, 'get_project_board', { projectKey: key });
      expect(board.data['agentsNotEnabled']).toEqual([{ id: reviewer.id, name: 'Reviewer' }]);

      await setAccess(reviewer.id, true);
      const ok = await callTool(client, 'create_subissue', {
        title: 'Review it',
        assigneeAgentId: reviewer.id,
      });
      expect(ok.isError).toBe(false);
      await client.close();
    });
  });

  describe('permissions', () => {
    it('lets owners and admins change access; members and viewers only read', async () => {
      for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
        await createUser(ctx, `${role}@example.com`, role);
        const { cookie } = await signIn(ctx, `${role}@example.com`);
        const read = await asBrowser(ctx, cookie, {
          method: 'GET',
          url: `/api/projects/${fx.projectId}/agents`,
        });
        expect(read.statusCode, role).toBe(200);
        const write = await asBrowser(ctx, cookie, {
          method: 'PUT',
          url: `/api/projects/${fx.projectId}/agents/${dev.id}`,
          payload: { enabled: false },
        });
        expect(write.statusCode, role).toBe(role === 'owner' || role === 'admin' ? 200 : 403);
      }
      const entry = await ctx.database.collections.audit.findOne({
        action: 'project.agent_access_changed',
      });
      expect(entry?.actor).toMatchObject({ type: 'user' });
    });
  });
});
