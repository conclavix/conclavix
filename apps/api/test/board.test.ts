import { ObjectId } from 'mongodb';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BOARD_COLUMNS, type BoardColumn } from '@conclavix/core';
import { createTestContext, type TestContext } from './helpers.js';

interface IssueBody {
  id: string;
  key: string;
  status: string;
  columnId: string | null;
}

const column = (id: string, status: string, title = id): Record<string, string> => ({
  id,
  title,
  status,
});

const withExtra = (...extra: Record<string, string>[]): Record<string, string>[] => [
  ...DEFAULT_BOARD_COLUMNS.map((entry) => ({ ...entry })),
  ...extra,
];

describe('project board columns', () => {
  let ctx: TestContext;
  let projectId: string;
  let counter = 0;

  const getBoard = async () =>
    (await ctx.request({ method: 'GET', url: `/api/projects/${projectId}/board` })).json();
  const putBoard = (revision: number, columns: unknown[]) =>
    ctx.request({
      method: 'PUT',
      url: `/api/projects/${projectId}/board`,
      payload: { revision, columns },
    });
  const createIssue = (payload: Record<string, unknown>) =>
    ctx.request({ method: 'POST', url: '/api/issues', payload: { projectId, ...payload } });
  const issue = async (payload: Record<string, unknown> = {}): Promise<IssueBody> =>
    (await createIssue({ title: 'work', ...payload })).json();
  const patch = (ref: string, payload: Record<string, unknown>) =>
    ctx.request({ method: 'PATCH', url: `/api/issues/${ref}`, payload });
  const read = async (ref: string): Promise<IssueBody> =>
    (await ctx.request({ method: 'GET', url: `/api/issues/${ref}` })).json();
  const pendingWakes = (issueId: string) =>
    ctx.database.collections.wakes.countDocuments({
      issueId: new ObjectId(issueId),
      processedAt: null,
    });

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  beforeEach(async () => {
    counter += 1;
    const project = await ctx.request({
      method: 'POST',
      url: '/api/projects',
      payload: { key: `B${counter}`, name: `Board ${counter}` },
    });
    projectId = project.json().id;
  });

  afterAll(async () => {
    await ctx.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serves the default columns for a project without a stored board', async () => {
    expect(await getBoard()).toEqual({
      projectId,
      revision: 0,
      columns: DEFAULT_BOARD_COLUMNS,
    });
    expect(await issue()).toMatchObject({ status: 'todo', columnId: 'todo' });
    expect(await issue({ status: 'backlog' })).toMatchObject({ columnId: 'backlog' });
    const missing = await ctx.request({
      method: 'GET',
      url: '/api/projects/0123456789abcdef01234567/board',
    });
    expect(missing.statusCode).toBe(404);
  });

  it('rejects duplicate ids, missing categories, too many columns and bad titles', async () => {
    const duplicate = await putBoard(0, withExtra(column('todo', 'todo')));
    expect(duplicate.statusCode).toBe(400);
    expect(JSON.stringify(duplicate.json().details)).toMatch(/duplicate column id todo/);

    const missing = await putBoard(
      0,
      DEFAULT_BOARD_COLUMNS.filter((entry) => entry.status !== 'in_review'),
    );
    expect(missing.statusCode).toBe(400);
    expect(JSON.stringify(missing.json().details)).toMatch(/no column for status in_review/);

    const extra = Array.from({ length: 15 }, (_, i) => column(`extra-${i}`, 'todo'));
    expect((await putBoard(0, withExtra(...extra))).statusCode).toBe(400);
    expect((await putBoard(0, withExtra(column('long', 'todo', 'x'.repeat(41))))).statusCode).toBe(
      400,
    );
    expect((await putBoard(0, withExtra(column('Bad Id', 'todo')))).statusCode).toBe(400);
    expect((await getBoard()).revision).toBe(0);
  });

  it('stores a new layout, generates missing ids and rejects a stale revision', async () => {
    const saved = await putBoard(0, [
      ...withExtra(column('ready', 'todo', 'Ready')),
      { title: 'Blocked', status: 'in_progress' },
    ]);
    expect(saved.statusCode).toBe(200);
    const board = saved.json();
    expect(board.revision).toBe(1);
    expect(board.columns).toHaveLength(8);
    expect(board.columns[7]).toMatchObject({ title: 'Blocked', status: 'in_progress' });
    expect(board.columns[7].id).toMatch(/^c-[0-9a-f]{8}$/);
    expect(await getBoard()).toEqual(board);

    const stale = await putBoard(0, withExtra());
    expect(stale.statusCode).toBe(409);
    expect(stale.json().details).toEqual({ revision: 1 });
  });

  it('lets only one of two concurrent edits of the same revision win', async () => {
    const results = await Promise.all([
      putBoard(0, withExtra(column('first', 'todo'))),
      putBoard(0, withExtra(column('second', 'todo'))),
    ]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    const board = await getBoard();
    expect(board.revision).toBe(1);
    expect(board.columns).toHaveLength(7);
  });

  it('moves an issue by column and sets its status from the column category', async () => {
    await putBoard(0, withExtra(column('ready', 'todo')));
    const created = await issue();
    const ready = await patch(created.key, { columnId: 'ready' });
    expect(ready.json()).toMatchObject({ status: 'todo', columnId: 'ready' });
    const doing = await patch(created.key, { columnId: 'in_progress' });
    expect(doing.json()).toMatchObject({ status: 'in_progress', columnId: 'in_progress' });

    expect((await patch(created.key, { columnId: 'nowhere' })).statusCode).toBe(422);
    const mismatch = await patch(created.key, { columnId: 'ready', status: 'in_review' });
    expect(mismatch.statusCode).toBe(422);
    expect(await read(created.key)).toMatchObject({
      status: 'in_progress',
      columnId: 'in_progress',
    });
  });

  it('keeps the column on a status-only change when it fits, else uses the first of that status', async () => {
    await putBoard(0, withExtra(column('ready', 'todo')));
    const created = await issue({ columnId: 'ready' });
    expect(created).toMatchObject({ status: 'todo', columnId: 'ready' });
    expect((await patch(created.key, { status: 'todo', title: 'renamed' })).json()).toMatchObject({
      columnId: 'ready',
    });
    expect((await patch(created.key, { status: 'in_progress' })).json()).toMatchObject({
      columnId: 'in_progress',
    });
    expect((await patch(created.key, { status: 'todo' })).json()).toMatchObject({
      columnId: 'todo',
    });
  });

  it('validates the column on create', async () => {
    await putBoard(0, withExtra(column('ready', 'todo')));
    expect((await createIssue({ title: 'x', columnId: 'done' })).statusCode).toBe(422);
    expect((await createIssue({ title: 'x', columnId: 'nowhere' })).statusCode).toBe(422);
    expect(
      (await createIssue({ title: 'x', columnId: 'ready', status: 'backlog' })).statusCode,
    ).toBe(422);
    expect(await issue({ columnId: 'in_progress' })).toMatchObject({ status: 'in_progress' });
  });

  it('moves issues of a deleted column to the first remaining column of its status', async () => {
    await putBoard(0, withExtra(column('ready', 'todo'), column('later', 'todo')));
    const moved = await issue({ columnId: 'ready' });
    const stays = await issue({ columnId: 'later' });
    const columns = withExtra(column('later', 'todo')).filter((entry) => entry.id !== 'todo');
    expect((await putBoard(1, columns)).statusCode).toBe(200);
    expect(await read(moved.key)).toMatchObject({ status: 'todo', columnId: 'later' });
    expect(await read(stays.key)).toMatchObject({ status: 'todo', columnId: 'later' });
  });

  it('pins issues placed by status so a new leading column does not pull them over', async () => {
    const legacy = await issue();
    await ctx.database.collections.issues.updateOne(
      { _id: new ObjectId(legacy.id) },
      { $unset: { columnId: '' } },
    );
    expect((await read(legacy.key)).columnId).toBeNull();
    const columns = [column('fresh', 'todo'), ...withExtra()];
    expect((await putBoard(0, columns)).statusCode).toBe(200);
    expect(await read(legacy.key)).toMatchObject({ status: 'todo', columnId: 'todo' });
    expect(await issue()).toMatchObject({ columnId: 'fresh' });
  });

  const seedRelocations = async (count: number) => {
    await putBoard(0, withExtra(column('ready', 'todo'), column('later', 'todo')));
    const created = await issue({ columnId: 'ready' });
    const template = await ctx.database.collections.issues.findOne({
      _id: new ObjectId(created.id),
    });
    if (!template) throw new Error('missing test issue');
    await ctx.database.collections.issues.insertMany(
      Array.from({ length: count - 1 }, (_, index) => ({
        ...template,
        _id: new ObjectId(),
        key: `${template.key}-copy-${index}`,
        number: index + 2,
        columnId: index % 2 === 0 ? 'later' : 'ready',
      })),
    );
    await ctx.database.collections.counters.updateOne(
      { _id: `issue-number:${projectId}` },
      { $set: { value: count } },
    );
  };

  it.each(['pins', 'statuses', 'mixed'])(
    'rejects more than 1,000 relocations across columns before loading issues (%s)',
    async (kind) => {
      await seedRelocations(1001);
      const columns =
        kind === 'pins'
          ? withExtra()
          : kind === 'statuses'
            ? withExtra(column('ready', 'in_progress'), column('later', 'in_progress'))
            : withExtra(column('ready', 'in_progress'));
      const find = vi.spyOn(ctx.database.collections.issues, 'find').mockImplementation(() => {
        throw new Error('issues loaded before rejecting the oversized edit');
      });

      const refused = await putBoard(1, columns);

      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toMatchObject({ error: 'unprocessable' });
      expect(find).not.toHaveBeenCalled();
      expect((await getBoard()).revision).toBe(1);
      expect(
        await ctx.database.collections.issues.countDocuments({
          projectId: new ObjectId(projectId),
          status: 'todo',
          columnId: { $in: ['ready', 'later'] },
        }),
      ).toBe(1001);
    },
  );

  it('allows exactly 1,000 relocations and excludes issues that stay in their column', async () => {
    await seedRelocations(1000);
    const stays = await issue();

    expect((await putBoard(1, withExtra())).statusCode).toBe(200);
    expect((await getBoard()).revision).toBe(2);
    expect(
      await ctx.database.collections.issues.countDocuments({
        projectId: new ObjectId(projectId),
        status: 'todo',
        columnId: 'todo',
      }),
    ).toBe(1001);
    expect(await read(stays.key)).toMatchObject({ status: 'todo', columnId: 'todo' });
  });

  it('changes the status of issues when their column changes category and wakes like a status change', async () => {
    const agent = (
      await ctx.request({
        method: 'POST',
        url: '/api/agents',
        payload: {
          name: `agent-${new ObjectId().toHexString()}`,
          role: 'engineer',
          adapter: { type: 'claude_cli' },
        },
      })
    ).json();
    await putBoard(0, withExtra(column('qa', 'in_review')));
    const reviewed = await issue({ assigneeAgentId: agent.id });
    expect((await patch(reviewed.key, { columnId: 'qa' })).json().status).toBe('in_review');
    await ctx.database.collections.wakes.deleteMany({});

    const changed = withExtra(column('qa', 'in_progress'));
    expect((await putBoard(1, changed)).statusCode).toBe(200);
    expect(await read(reviewed.key)).toMatchObject({ status: 'in_progress', columnId: 'qa' });
    expect(await pendingWakes(reviewed.id)).toBe(1);
  });

  it('closes a parent and its child together but refuses to close a parent with open children', async () => {
    await putBoard(0, withExtra(column('ship', 'in_review')));
    const parent = await issue({ columnId: 'ship' });
    const child = await issue({ parentId: parent.id, columnId: 'ship' });
    const elsewhere = await issue({ parentId: parent.id });

    const closing = withExtra(column('ship', 'done'));
    const refused = await putBoard(1, closing);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().message).toContain(parent.key);
    expect(await read(child.key)).toMatchObject({ status: 'in_review', columnId: 'ship' });
    expect((await getBoard()).revision).toBe(1);

    expect((await patch(elsewhere.key, { status: 'cancelled' })).statusCode).toBe(200);
    expect((await putBoard(1, closing)).statusCode).toBe(200);
    expect(await read(parent.key)).toMatchObject({ status: 'done', columnId: 'ship' });
    expect(await read(child.key)).toMatchObject({ status: 'done', columnId: 'ship' });
  });

  it('never leaves an issue in a column deleted by a concurrent board edit', async () => {
    const withReady: BoardColumn[] = [
      ...DEFAULT_BOARD_COLUMNS,
      { id: 'ready', title: 'Ready', status: 'todo' },
    ];
    await putBoard(0, withReady);
    const existing = await issue();
    const [edit, move, ...creates] = await Promise.all([
      putBoard(1, [...DEFAULT_BOARD_COLUMNS]),
      patch(existing.key, { columnId: 'ready' }),
      ...Array.from({ length: 10 }, () => createIssue({ title: 'racing', columnId: 'ready' })),
    ]);
    expect(edit.statusCode).toBe(200);
    for (const response of [move, ...creates]) {
      expect([200, 201, 422]).toContain(response.statusCode);
    }
    const stored = await ctx.database.collections.issues
      .find({ projectId: new ObjectId(projectId) })
      .toArray();
    expect(stored.map((doc) => doc.columnId)).toEqual(stored.map(() => 'todo'));
  });
});
