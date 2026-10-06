import { ObjectId } from 'mongodb';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';
import { callTool, connectAgent, startRunFor } from './mcp-helpers.js';
import { createFixture, type Fixture } from './scheduler-helpers.js';

type Ref = { id: string; key: string };

describe('collaboration tools across an issue tree', () => {
  let ctx: TestContext;
  let fx: Fixture;
  let baseUrl: string;
  let manager: { id: string };
  let engineer: { id: string };
  let epic: Ref;
  let child: Ref;
  let grandchild: Ref;
  let sibling: Ref;
  let unrelated: Ref;

  const link = async (from: string, to: string, type: 'delegates' | 'reports') => {
    const response = await ctx.request({
      method: 'POST',
      url: '/api/agent-links',
      payload: { from, to, type },
    });
    expect(response.statusCode).toBe(201);
  };
  const writeDoc = async (ref: string, key: string, body: string) => {
    const response = await ctx.request({
      method: 'PUT',
      url: `/api/issues/${ref}/documents/${key}`,
      payload: { title: `${key} of ${ref}`, body },
    });
    expect(response.statusCode).toBe(201);
  };
  const issueDoc = (id: string) =>
    ctx.database.collections.issues.findOne({ _id: new ObjectId(id) });
  const connectRun = async (issueId: string): Promise<{ client: Client; runId: ObjectId }> => {
    const { run, token } = await startRunFor(ctx, fx, issueId);
    return { client: await connectAgent(baseUrl, token), runId: run._id };
  };

  beforeEach(async () => {
    ctx = await createTestContext();
    baseUrl = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    fx = await createFixture(ctx);
    manager = await fx.agent({ name: 'Manager', role: 'manager' });
    engineer = await fx.agent({ name: 'Engineer' });
    await link(manager.id, engineer.id, 'delegates');
    await link(engineer.id, manager.id, 'reports');
    epic = await fx.issue({ title: 'Ship it', assigneeAgentId: manager.id });
    child = await fx.issue({ title: 'Build', parentId: epic.id });
    grandchild = await fx.issue({ title: 'Build part', parentId: child.id });
    sibling = await fx.issue({ title: 'Other epic' });
    unrelated = await fx.issue({ title: 'Other work', parentId: sibling.id });
    await writeDoc(epic.key, 'plan', 'the plan');
    await writeDoc(child.key, 'result', 'child result');
    await writeDoc(grandchild.key, 'review', 'grandchild review');
    await writeDoc(sibling.key, 'secret-plan', 'not yours');
    await writeDoc(unrelated.key, 'notes', 'not yours either');
  });

  afterEach(async () => {
    await ctx.close();
  });

  describe('documents', () => {
    it('reads documents of direct and transitive sub-issues but nothing outside the tree', async () => {
      const { client } = await connectRun(epic.id);
      const fromChild = await callTool(client, 'read_document', { key: 'result', ref: child.key });
      expect(fromChild.isError).toBe(false);
      expect(fromChild.data).toMatchObject({ body: 'child result' });
      const deep = await callTool(client, 'read_document', { key: 'review', ref: grandchild.key });
      expect(deep.data).toMatchObject({ body: 'grandchild review' });

      for (const [ref, key] of [
        [sibling.key, 'secret-plan'],
        [unrelated.key, 'notes'],
      ] as const) {
        const denied = await callTool(client, 'read_document', { key, ref });
        expect(denied.isError).toBe(true);
        expect(denied.data.error).toMatch(/issue tree only/);
      }
      await client.close();
    });

    it('lets a sub-issue read its parents but not its siblings', async () => {
      await fx.patch(child.key, { assigneeAgentId: engineer.id });
      const cousin = await fx.issue({ title: 'Cousin', parentId: epic.id });
      await writeDoc(cousin.key, 'design', 'cousin design');
      const { client } = await connectRun(child.id);
      expect(
        (await callTool(client, 'read_document', { key: 'plan', ref: epic.key })).isError,
      ).toBe(false);
      const denied = await callTool(client, 'read_document', { key: 'design', ref: cousin.key });
      expect(denied.isError).toBe(true);
      await client.close();
    });

    it('lists the documents of the tree with their issue and nothing else', async () => {
      const { client } = await connectRun(epic.id);
      const listed = await callTool(client, 'list_documents');
      expect(listed.isError).toBe(false);
      expect(listed.data).toEqual({
        documents: [
          expect.objectContaining({
            issueKey: epic.key,
            relation: 'own',
            key: 'plan',
            revision: 1,
          }),
          expect.objectContaining({ issueKey: child.key, relation: 'sub-issue', key: 'result' }),
          expect.objectContaining({
            issueKey: grandchild.key,
            relation: 'sub-issue',
            key: 'review',
          }),
        ],
        truncated: false,
      });
      await client.close();

      await fx.patch(grandchild.key, { assigneeAgentId: engineer.id });
      const below = await connectRun(grandchild.id);
      const fromBelow = await callTool(below.client, 'list_documents');
      expect(
        (fromBelow.data['documents'] as { issueKey: string; relation: string }[]).map(
          (doc) => `${doc.issueKey}:${doc.relation}`,
        ),
      ).toEqual([`${grandchild.key}:own`, `${child.key}:parent`, `${epic.key}:parent`]);
      await below.client.close();
    });
  });

  describe('reopen_issue', () => {
    beforeEach(async () => {
      await fx.patch(child.key, { assigneeAgentId: engineer.id });
      await fx.patch(grandchild.key, { status: 'done' });
      await fx.patch(child.key, { status: 'done' });
      await fx.patch(unrelated.key, { status: 'done' });
    });

    it('reopens a closed sub-issue with the reason as comment and wakes its assignee', async () => {
      const { client, runId } = await connectRun(epic.id);
      const progressBefore = (await issueDoc(epic.id))?.progress ?? 0;
      const reopened = await callTool(client, 'reopen_issue', {
        ref: child.key,
        reason: 'The error path has no test.',
      });
      expect(reopened.isError).toBe(false);
      expect(reopened.data).toMatchObject({ key: child.key, status: 'todo' });
      await client.close();

      const comments = await ctx.database.collections.comments
        .find({ issueId: new ObjectId(child.id) })
        .toArray();
      expect(comments.at(-1)).toMatchObject({
        author: { type: 'agent', agentId: manager.id },
        body: expect.stringContaining('The error path has no test.'),
      });
      expect(await ctx.database.collections.wakes.find({ processedAt: null }).toArray()).toEqual([
        expect.objectContaining({
          agentId: new ObjectId(engineer.id),
          issueId: new ObjectId(child.id),
        }),
      ]);
      expect((await issueDoc(epic.id))?.progress).toBe(progressBefore + 1);
      const finished = await fx.scheduler.finishRun(runId, { status: 'succeeded', costUsd: 0 });
      expect(finished.madeProgress).toBe(true);
    });

    it('reopens deeper sub-issues and in_review ones once their parent is open', async () => {
      const { client } = await connectRun(epic.id);
      const parentClosed = await callTool(client, 'reopen_issue', {
        ref: grandchild.key,
        reason: 'again',
      });
      expect(parentClosed.isError).toBe(true);
      expect(parentClosed.data.error).toMatch(/parent is closed/);
      expect((await issueDoc(grandchild.id))?.status).toBe('done');

      await callTool(client, 'reopen_issue', { ref: child.key, reason: 'fix it' });
      expect(
        (await callTool(client, 'reopen_issue', { ref: grandchild.key, reason: 'and this' }))
          .isError,
      ).toBe(false);
      await fx.patch(grandchild.key, { status: 'in_review' });
      const review = await callTool(client, 'reopen_issue', { ref: grandchild.key, reason: 'go' });
      expect(review.data).toMatchObject({ status: 'todo' });
      await client.close();
    });

    it('refuses issues outside its subtree, open issues and a missing reason', async () => {
      await fx.patch(child.key, { status: 'todo' });
      const { client } = await connectRun(child.id);
      for (const ref of [epic.key, child.key, unrelated.key]) {
        const denied = await callTool(client, 'reopen_issue', { ref, reason: 'please' });
        expect(denied.isError).toBe(true);
        expect(denied.data.error).toMatch(/only sub-issues below your issue/);
      }
      expect((await issueDoc(unrelated.id))?.status).toBe('done');

      const emptyReason = await callTool(client, 'reopen_issue', {
        ref: grandchild.key,
        reason: '   ',
      });
      expect(emptyReason.isError).toBe(true);
      const noReason = await callTool(client, 'reopen_issue', { ref: grandchild.key });
      expect(noReason.isError).toBe(true);
      expect((await issueDoc(grandchild.id))?.status).toBe('done');
      expect(
        await ctx.database.collections.comments.countDocuments({
          issueId: new ObjectId(grandchild.id),
        }),
      ).toBe(0);

      await callTool(client, 'reopen_issue', { ref: grandchild.key, reason: 'redo' });
      const stillOpen = await callTool(client, 'reopen_issue', {
        ref: grandchild.key,
        reason: 'x',
      });
      expect(stillOpen.isError).toBe(true);
      expect(stillOpen.data.error).toMatch(/only done, cancelled or in_review/);
      await client.close();
    });

    it('stops agent reopens after three rounds; the board can still reopen', async () => {
      const { client } = await connectRun(epic.id);
      for (let round = 0; round < 3; round += 1) {
        const reopened = await callTool(client, 'reopen_issue', { ref: child.key, reason: 'r' });
        expect(reopened.isError).toBe(false);
        await fx.patch(child.key, { status: 'done' });
      }
      const capped = await callTool(client, 'reopen_issue', { ref: child.key, reason: 'r' });
      expect(capped.isError).toBe(true);
      expect(capped.data.error).toMatch(/3 times already; ask the board/);
      await client.close();
      expect(await fx.patch(child.key, { status: 'todo' })).toMatchObject({ status: 'todo' });
    });
  });

  describe('create_subissue blockedBy', () => {
    it('accepts sibling sub-issues only and wakes the assignee once they close', async () => {
      const { client, runId } = await connectRun(epic.id);
      const api = (
        await callTool(client, 'create_subissue', { title: 'API', assigneeAgentId: engineer.id })
      ).data as Ref;
      for (const ref of [grandchild.key, unrelated.key, epic.key]) {
        const denied = await callTool(client, 'create_subissue', {
          title: 'UI',
          assigneeAgentId: engineer.id,
          blockedBy: [ref],
        });
        expect(denied.isError).toBe(true);
        expect(denied.data.error).toMatch(/is not a sub-issue of your issue/);
      }
      const missing = await callTool(client, 'create_subissue', {
        title: 'UI',
        blockedBy: ['S999-1'],
      });
      expect(missing.isError).toBe(true);

      const ui = await callTool(client, 'create_subissue', {
        title: 'UI',
        assigneeAgentId: engineer.id,
        blockedBy: [api.key, child.key],
      });
      expect(ui.isError).toBe(false);
      const uiIssue = ui.data as Ref & { blockedBy: string[] };
      expect(uiIssue.blockedBy).toEqual([api.id, child.id]);
      await client.close();
      await fx.scheduler.finishRun(runId, { status: 'succeeded', costUsd: 0 });

      await fx.scheduler.processPendingWakes();
      const uiWake = await ctx.database.collections.wakes.findOne({
        issueId: new ObjectId(uiIssue.id),
      });
      expect(uiWake?.skipReason).toBe('blocked');

      await fx.patch(api.key, { status: 'done' });
      expect(
        await ctx.database.collections.wakes.countDocuments({
          issueId: new ObjectId(uiIssue.id),
          processedAt: null,
        }),
      ).toBe(0);
      await fx.patch(grandchild.key, { status: 'cancelled' });
      await fx.patch(child.key, { status: 'cancelled' });
      expect(
        await ctx.database.collections.wakes.findOne({
          issueId: new ObjectId(uiIssue.id),
          processedAt: null,
        }),
      ).toMatchObject({ agentId: new ObjectId(engineer.id), reason: 'unblocked' });
    });
  });
});
