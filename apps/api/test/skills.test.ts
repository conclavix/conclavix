import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';

describe('skills', () => {
  let ctx: TestContext;
  let counter = 0;

  const createSkill = async (payload: Record<string, unknown> = {}) => {
    counter += 1;
    const response = await ctx.request({
      method: 'POST',
      url: '/api/skills',
      payload: { name: `skill-${counter}`, description: 'Does a thing', ...payload },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string; name: string };
  };
  const createAgent = async (payload: Record<string, unknown> = {}) => {
    counter += 1;
    return ctx.request({
      method: 'POST',
      url: '/api/agents',
      payload: {
        name: `agent-${counter}`,
        role: 'engineer',
        adapter: { type: 'claude_cli' },
        ...payload,
      },
    });
  };

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('creates, reads, lists, updates and deletes a skill', async () => {
    const created = await ctx.request({
      method: 'POST',
      url: '/api/skills',
      payload: {
        name: 'release-notes',
        description: 'Write release notes',
        body: '# Release notes\n',
        files: [{ path: 'templates/notes.md', content: '## Changes' }],
      },
    });
    expect(created.statusCode).toBe(201);
    const skill = created.json();
    expect(skill).toMatchObject({
      name: 'release-notes',
      body: '# Release notes\n',
      files: [{ path: 'templates/notes.md', content: '## Changes' }],
    });

    const read = await ctx.request({ method: 'GET', url: `/api/skills/${skill.id}` });
    expect(read.json()).toMatchObject({ id: skill.id, description: 'Write release notes' });

    const list = await ctx.request({ method: 'GET', url: '/api/skills' });
    const item = list.json().items.find((entry: { id: string }) => entry.id === skill.id);
    expect(item).toMatchObject({ name: 'release-notes', fileCount: 1 });
    expect(item).not.toHaveProperty('body');
    expect(item).not.toHaveProperty('files');

    const updated = await ctx.request({
      method: 'PATCH',
      url: `/api/skills/${skill.id}`,
      payload: { description: 'Draft release notes', body: 'new body' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      name: 'release-notes',
      description: 'Draft release notes',
      body: 'new body',
      files: [{ path: 'templates/notes.md' }],
    });

    const cleared = await ctx.request({
      method: 'PATCH',
      url: `/api/skills/${skill.id}`,
      payload: { files: [] },
    });
    expect(cleared.json().files).toEqual([]);

    const removed = await ctx.request({ method: 'DELETE', url: `/api/skills/${skill.id}` });
    expect(removed.statusCode).toBe(204);
    const gone = await ctx.request({ method: 'GET', url: `/api/skills/${skill.id}` });
    expect(gone.statusCode).toBe(404);
  });

  it('rejects duplicate names on create and rename with 409', async () => {
    const first = await createSkill();
    const second = await createSkill();
    const duplicate = await ctx.request({
      method: 'POST',
      url: '/api/skills',
      payload: { name: first.name, description: 'again' },
    });
    expect(duplicate.statusCode).toBe(409);
    const rename = await ctx.request({
      method: 'PATCH',
      url: `/api/skills/${second.id}`,
      payload: { name: first.name },
    });
    expect(rename.statusCode).toBe(409);
  });

  it('rejects unsafe names and file paths with 400 before anything is stored', async () => {
    const attempts = [
      { name: '../evil', description: 'x' },
      { name: 'Evil', description: 'x' },
      { name: 'ok-name', description: 'x', files: [{ path: '../../.bashrc', content: 'x' }] },
      { name: 'ok-name', description: 'x', files: [{ path: '/etc/cron.d/x', content: 'x' }] },
      { name: 'ok-name', description: 'x', files: [{ path: 'SKILL.md', content: 'x' }] },
      {
        name: 'ok-name',
        description: 'x',
        files: [{ path: '.claude/settings.json', content: '' }],
      },
      { name: 'ok-name', description: 'line one\nline two' },
    ];
    for (const payload of attempts) {
      const response = await ctx.request({ method: 'POST', url: '/api/skills', payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(await ctx.database.collections.skills.countDocuments({ name: 'ok-name' })).toBe(0);
  });

  it('assigns skills to agents and validates the ids', async () => {
    const skill = await createSkill();
    const plain = await createAgent();
    expect(plain.json().skillIds).toEqual([]);

    const withSkill = await createAgent({ skillIds: [skill.id] });
    expect(withSkill.statusCode).toBe(201);
    expect(withSkill.json().skillIds).toEqual([skill.id]);

    const unknown = await ctx.request({
      method: 'PATCH',
      url: `/api/agents/${plain.json().id}`,
      payload: { skillIds: ['0123456789abcdef01234567'] },
    });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().details).toEqual({ missing: ['0123456789abcdef01234567'] });

    const duplicate = await ctx.request({
      method: 'PATCH',
      url: `/api/agents/${plain.json().id}`,
      payload: { skillIds: [skill.id, skill.id] },
    });
    expect(duplicate.statusCode).toBe(400);

    const assigned = await ctx.request({
      method: 'PATCH',
      url: `/api/agents/${plain.json().id}`,
      payload: { skillIds: [skill.id] },
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().skillIds).toEqual([skill.id]);
    const read = await ctx.request({ method: 'GET', url: `/api/agents/${plain.json().id}` });
    expect(read.json().skillIds).toEqual([skill.id]);
  });

  it('reports agents stored before skills existed with no skills', async () => {
    const agent = (await createAgent()).json();
    await ctx.database.collections.agents.updateOne(
      { name: agent.name },
      { $unset: { skillIds: '' } },
    );
    const read = await ctx.request({ method: 'GET', url: `/api/agents/${agent.id}` });
    expect(read.json().skillIds).toEqual([]);
  });

  it('refuses to delete an assigned skill and allows it once unassigned', async () => {
    const skill = await createSkill();
    const agent = (await createAgent({ skillIds: [skill.id] })).json();

    const refused = await ctx.request({ method: 'DELETE', url: `/api/skills/${skill.id}` });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().details).toEqual({ agents: [agent.name] });

    await ctx.request({
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      payload: { skillIds: [] },
    });
    const removed = await ctx.request({ method: 'DELETE', url: `/api/skills/${skill.id}` });
    expect(removed.statusCode).toBe(204);
  });

  it('returns 404 for unknown and malformed ids', async () => {
    const unknown = await ctx.request({
      method: 'GET',
      url: '/api/skills/0123456789abcdef01234567',
    });
    expect(unknown.statusCode).toBe(404);
    const malformed = await ctx.request({ method: 'DELETE', url: '/api/skills/not-an-id' });
    expect(malformed.statusCode).toBe(404);
  });
});
