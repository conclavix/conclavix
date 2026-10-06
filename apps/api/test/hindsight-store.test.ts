import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HindsightClient } from '../src/modules/memory/hindsight-client.js';
import { HindsightMemoryStore } from '../src/modules/memory/hindsight-store.js';
import { startFakeHindsight } from './fixtures/fake-hindsight.js';
import { createTestContext, type TestContext } from './helpers.js';
import { createFixture } from './scheduler-helpers.js';

describe('hindsight store specifics', () => {
  let fake: Awaited<ReturnType<typeof startFakeHindsight>>;
  let ctx: TestContext;

  beforeAll(async () => {
    fake = await startFakeHindsight({ retainDelayMs: 30 });
    ctx = await createTestContext({
      memoryStore: new HindsightMemoryStore(
        new HindsightClient({ baseUrl: fake.url, bank: 'specifics' }),
      ),
    });
  });

  afterAll(async () => {
    await ctx.close();
    await fake.close();
  });

  it('ignores documents in the bank that Conclavix did not write or whose metadata is broken', async () => {
    const now = new Date().toISOString();
    fake.docs.set('someone-else', {
      id: 'someone-else',
      original_text: 'foreign zebra',
      tags: ['scope:global'],
      document_metadata: {},
      created_at: now,
      updated_at: now,
    });
    fake.docs.set('cvx_broken', {
      id: 'cvx_broken',
      original_text: 'broken zebra',
      tags: ['scope:global'],
      document_metadata: { title: 'x', scope: 'galaxy' },
      created_at: now,
      updated_at: now,
    });
    await ctx.request({
      method: 'POST',
      url: '/api/memories',
      payload: { scope: 'global', title: 'Real zebra', body: 'zebra fact' },
    });

    const listed = await ctx.request({ method: 'GET', url: '/api/memories?scope=global' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items.map((m: { title: string }) => m.title)).toEqual(['Real zebra']);
    const searched = await ctx.request({ method: 'GET', url: '/api/memories?q=zebra' });
    expect(searched.json().items.map((m: { title: string }) => m.title)).toEqual(['Real zebra']);
  });

  it('skips entries whose scope has no owner instead of moving them to global', async () => {
    const now = new Date().toISOString();
    fake.docs.set('cvx_ownerless', {
      id: 'cvx_ownerless',
      original_text: 'Orphan\n\nwombat orphan fact',
      tags: ['scope:global'],
      document_metadata: {
        title: 'Orphan',
        scope: 'project',
        projectId: '',
        agentId: '',
        createdAt: 'not a date',
      },
      created_at: now,
      updated_at: now,
    });
    const listed = (await ctx.request({ method: 'GET', url: '/api/memories?q=wombat' })).json()
      .items;
    expect(listed).toEqual([]);
    expect(
      (await ctx.request({ method: 'GET', url: '/api/memories/cvx_ownerless' })).statusCode,
    ).toBe(404);
  });

  it('never ends with two entries of one title when a rename and a save race', async () => {
    for (let round = 0; round < 5; round += 1) {
      const a = (
        await ctx.request({
          method: 'POST',
          url: '/api/memories',
          payload: { scope: 'global', title: `Old ${round}`, body: 'a' },
        })
      ).json();
      await Promise.all([
        ctx.request({
          method: 'PATCH',
          url: `/api/memories/${a.id}`,
          payload: { title: `Target ${round}` },
        }),
        ctx.request({
          method: 'POST',
          url: '/api/memories',
          payload: { scope: 'global', title: `Target ${round}`, body: 'b' },
        }),
      ]);
      const titles = [...fake.docs.values()].map((doc) => doc.document_metadata['title']);
      expect(titles.filter((title) => title === `Target ${round}`)).toHaveLength(1);
    }
  });
  it('keeps a real fact when a foreign result with the same text comes first', async () => {
    const now = new Date(Date.now() - 60_000).toISOString();
    fake.docs.set('aaa-foreign', {
      id: 'aaa-foreign',
      original_text: 'quokka habitat note',
      tags: ['scope:global'],
      document_metadata: { title: 'quokka habitat' },
      created_at: now,
      updated_at: now,
    });
    await ctx.request({
      method: 'POST',
      url: '/api/memories',
      payload: { scope: 'global', title: 'Quokka', body: 'quokka habitat note' },
    });
    const found = (
      await ctx.request({ method: 'GET', url: '/api/memories?q=quokka habitat' })
    ).json().items;
    expect(found.map((m: { title: string }) => m.title)).toEqual(['Quokka']);
  });

  it('rejects the second of two concurrent renames of the same entry', async () => {
    const a = (
      await ctx.request({
        method: 'POST',
        url: '/api/memories',
        payload: { scope: 'global', title: 'Rename me', body: 'x' },
      })
    ).json();
    const results = await Promise.all([
      ctx.request({
        method: 'PATCH',
        url: `/api/memories/${a.id}`,
        payload: { title: 'First name' },
      }),
      ctx.request({
        method: 'PATCH',
        url: `/api/memories/${a.id}`,
        payload: { title: 'Second name' },
      }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  });

  it('finds the real entry by title even when a broken document with the same tags is newer', async () => {
    const first = (
      await ctx.request({
        method: 'POST',
        url: '/api/memories',
        payload: { scope: 'global', title: 'Shadowed', body: 'v1' },
      })
    ).json();
    const real = fake.docs.get(first.id);
    if (!real) throw new Error('expected the stored document');
    const later = new Date(Date.now() + 60_000).toISOString();
    fake.docs.set('cvx_shadow', {
      id: 'cvx_shadow',
      original_text: 'broken',
      tags: [...real.tags],
      document_metadata: { title: 'Shadowed', scope: 'nonsense' },
      created_at: later,
      updated_at: later,
    });
    const again = await ctx.request({
      method: 'POST',
      url: '/api/memories',
      payload: { scope: 'global', title: 'Shadowed', body: 'v2' },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(first.id);
  });
});

describe('hindsight unavailable, seen by an agent', () => {
  it('gives the agent a readable error instead of crashing the run', async () => {
    const store = new HindsightMemoryStore(
      new HindsightClient({ baseUrl: 'http://127.0.0.1:9', bank: 'down', timeoutMs: 2000 }),
    );
    const ctx = await createTestContext({ memoryStore: store });
    try {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StreamableHTTPClientTransport } =
        await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      const baseUrl = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
      const fx = await createFixture(ctx);
      const agent = await fx.agent();
      const issue = await fx.issue({ title: 'needs memory', assigneeAgentId: agent.id });
      await fx.scheduler.processPendingWakes();
      const run = await ctx.database.collections.runs.findOne({ issueId: new ObjectId(issue.id) });
      if (!run) throw new Error('expected a run');
      const { token } = await fx.scheduler.startRun(run._id, 60_000);
      const client = new Client({ name: 'down-test', version: '1' });
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      await client.connect(transport as Parameters<typeof client.connect>[0]);
      const result = (await client.callTool({
        name: 'memory_save',
        arguments: { scope: 'agent', title: 'Note', body: 'remember this' },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('Memory is temporarily unavailable');
      await client.close();
    } finally {
      await ctx.close();
    }
  });
});
