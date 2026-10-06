import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HindsightClient } from '../src/modules/memory/hindsight-client.js';
import { HindsightMemoryStore } from '../src/modules/memory/hindsight-store.js';
import { startFakeHindsight } from './fixtures/fake-hindsight.js';
import { createTestContext, type TestContext } from './helpers.js';
import { createFixture, type Fixture } from './scheduler-helpers.js';

type ToolResponse = { isError?: boolean; content: { type: string; text: string }[] };

const backends = [
  { name: 'built-in store', setup: async () => ({ options: {}, close: async () => undefined }) },
  {
    name: 'hindsight store',
    setup: async () => {
      const fake = await startFakeHindsight();
      const store = new HindsightMemoryStore(
        new HindsightClient({ baseUrl: fake.url, bank: 'test' }),
      );
      return { options: { memoryStore: store }, close: fake.close };
    },
  },
];

describe.each(backends)('memory ($name)', ({ setup }) => {
  let ctx: TestContext;
  let baseUrl: string;
  let closeBackend: () => Promise<void>;

  const post = (payload: Record<string, unknown>) =>
    ctx.request({ method: 'POST', url: '/api/memories', payload });

  beforeAll(async () => {
    const backend = await setup();
    closeBackend = backend.close;
    ctx = await createTestContext(backend.options);
    baseUrl = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  });

  afterAll(async () => {
    await ctx.close();
    await closeBackend();
  });

  describe('board API', () => {
    it('creates memories per scope and validates the owner', async () => {
      const project = (
        await ctx.request({
          method: 'POST',
          url: '/api/projects',
          payload: { key: 'MEM', name: 'Mem' },
        })
      ).json();
      expect(
        (await post({ scope: 'global', title: 'House rule', body: 'English code' })).statusCode,
      ).toBe(201);
      expect(
        (await post({ scope: 'project', projectId: project.id, title: 'Stack', body: 'Fastify' }))
          .statusCode,
      ).toBe(201);
      expect((await post({ scope: 'project', title: 'No owner', body: 'x' })).statusCode).toBe(400);
      expect(
        (
          await post({
            scope: 'project',
            projectId: '0123456789abcdef01234567',
            title: 'Ghost',
            body: 'x',
          })
        ).statusCode,
      ).toBe(422);
      expect(
        (await post({ scope: 'global', title: 'x', body: 'x', author: { type: 'agent' } }))
          .statusCode,
      ).toBe(400);
    });

    it('updates an entry when the same title is saved again in the same scope', async () => {
      await post({ scope: 'global', title: 'Deploy window', body: 'Fridays never' });
      const again = await post({
        scope: 'global',
        title: '  deploy   WINDOW ',
        body: 'Fridays never, Mondays fine',
      });
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ revision: 2, body: 'Fridays never, Mondays fine' });
    });

    it('searches by text with title matches first, and filters by scope', async () => {
      await post({ scope: 'global', title: 'Redis keys', body: 'prefix everything with cvx:' });
      await post({ scope: 'global', title: 'Logging', body: 'never log redis passwords' });
      const hits = (await ctx.request({ method: 'GET', url: '/api/memories?q=redis' })).json()
        .items;
      expect(hits.map((hit: { title: string }) => hit.title).slice(0, 2)).toEqual([
        'Redis keys',
        'Logging',
      ]);
      const projectOnly = (
        await ctx.request({ method: 'GET', url: '/api/memories?scope=project' })
      ).json().items;
      expect(projectOnly.every((hit: { scope: string }) => hit.scope === 'project')).toBe(true);
    });

    it('fills the limit with the requested scope even when other scopes are newer', async () => {
      const project = (
        await ctx.request({
          method: 'POST',
          url: '/api/projects',
          payload: { key: 'LIM', name: 'Lim' },
        })
      ).json();
      for (let i = 0; i < 3; i += 1) {
        await post({
          scope: 'project',
          projectId: project.id,
          title: `Project note ${i}`,
          body: 'p',
        });
      }
      for (let i = 0; i < 6; i += 1) {
        await post({ scope: 'global', title: `Newer global ${i}`, body: 'g' });
      }
      const page = (
        await ctx.request({ method: 'GET', url: '/api/memories?scope=project&limit=2' })
      ).json().items;
      expect(page).toHaveLength(2);
      expect(page.every((item: { scope: string }) => item.scope === 'project')).toBe(true);
    });

    it('lists entries with their full body when no search text is given', async () => {
      await post({ scope: 'global', title: 'Body in list', body: 'the list shows this text' });
      const listed = (await ctx.request({ method: 'GET', url: '/api/memories?scope=global' }))
        .json()
        .items.find((item: { title: string }) => item.title === 'Body in list');
      expect(listed).toMatchObject({ body: 'the list shows this text' });
    });

    it('keeps the body unchanged when only the title is edited', async () => {
      const saved = (
        await post({ scope: 'global', title: 'Before rename', body: 'stays as is' })
      ).json();
      for (const title of ['After rename', 'After second rename']) {
        await ctx.request({
          method: 'PATCH',
          url: `/api/memories/${saved.id}`,
          payload: { title },
        });
      }
      const loaded = (
        await ctx.request({ method: 'GET', url: `/api/memories/${saved.id}` })
      ).json();
      expect(loaded).toMatchObject({ title: 'After second rename', body: 'stays as is' });
    });

    it('edits, refuses title collisions, and deletes', async () => {
      const a = (await post({ scope: 'global', title: 'Alpha', body: 'a' })).json();
      await post({ scope: 'global', title: 'Beta', body: 'b' });
      const patched = await ctx.request({
        method: 'PATCH',
        url: `/api/memories/${a.id}`,
        payload: { body: 'a2' },
      });
      expect(patched.json()).toMatchObject({ body: 'a2', revision: 2 });
      const clash = await ctx.request({
        method: 'PATCH',
        url: `/api/memories/${a.id}`,
        payload: { title: 'beta' },
      });
      expect(clash.statusCode).toBe(409);
      expect(
        (await ctx.request({ method: 'DELETE', url: `/api/memories/${a.id}` })).statusCode,
      ).toBe(204);
      expect((await ctx.request({ method: 'GET', url: `/api/memories/${a.id}` })).statusCode).toBe(
        404,
      );
    });
  });

  describe('agents over MCP', () => {
    let fx: Fixture;

    const clientFor = async (
      agentId: string,
      title: string,
      projectFx: Fixture = fx,
    ): Promise<Client> => {
      const issue = await projectFx.issue({ title, assigneeAgentId: agentId });
      await projectFx.scheduler.processPendingWakes();
      const run = await ctx.database.collections.runs.findOne({
        issueId: new ObjectId(issue.id),
        status: 'queued',
      });
      if (!run) throw new Error('expected a run');
      const { token } = await projectFx.scheduler.startRun(run._id, 60_000);
      const client = new Client({ name: 'mem-test', version: '1' });
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      await client.connect(transport as Parameters<Client['connect']>[0]);
      return client;
    };
    const call = async (client: Client, name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as ToolResponse;
      return {
        isError: result.isError === true,
        data: JSON.parse(result.content[0]?.text ?? 'null'),
      };
    };

    beforeAll(async () => {
      fx = await createFixture(ctx);
    });

    it('lets each agent read global, its project and its own memory, and nothing else', async () => {
      const alice = await fx.agent({ name: 'Alice' });
      const bob = await fx.agent({ name: 'Bob' });
      const otherProject = await createFixture(ctx);
      const carol = await otherProject.agent({ name: 'Carol' });

      await post({ scope: 'global', title: 'Global zebra rule', body: 'zebra everywhere' });
      const a = await clientFor(alice.id, 'alice work');
      expect(
        (
          await call(a, 'memory_save', {
            scope: 'project',
            title: 'Project zebra',
            body: 'zebra in project',
          })
        ).data.created,
      ).toBe(true);
      expect(
        (
          await call(a, 'memory_save', {
            scope: 'agent',
            title: 'Alice zebra',
            body: 'zebra private',
          })
        ).data.scope,
      ).toBe('agent');
      const c = await clientFor(carol.id, 'carol work', otherProject);
      await call(c, 'memory_save', {
        scope: 'project',
        title: 'Other project zebra',
        body: 'zebra elsewhere',
      });
      await call(c, 'memory_save', { scope: 'agent', title: 'Carol zebra', body: 'zebra carol' });

      const b = await clientFor(bob.id, 'bob work');
      const seenByBob = (await call(b, 'memory_search', { query: 'zebra' })).data
        .map((m: { title: string }) => m.title)
        .sort();
      expect(seenByBob).toEqual(['Global zebra rule', 'Project zebra']);
      const seenByAlice = (await call(a, 'memory_search', { query: 'zebra' })).data
        .map((m: { title: string }) => m.title)
        .sort();
      expect(seenByAlice).toEqual(['Alice zebra', 'Global zebra rule', 'Project zebra']);
      const aliceOwnOnly = (
        await call(a, 'memory_search', { query: 'zebra', scope: 'agent' })
      ).data.map((m: { title: string }) => m.title);
      expect(aliceOwnOnly).toEqual(['Alice zebra']);
      await Promise.all([a.close(), b.close(), c.close()]);
    });

    it('does not let agents write global memory', async () => {
      const dave = await fx.agent({ name: 'Dave' });
      const d = await clientFor(dave.id, 'dave work');
      const attempt = await d.callTool({
        name: 'memory_save',
        arguments: { scope: 'global', title: 'Rule', body: 'mine now' },
      });
      expect((attempt as ToolResponse).isError).toBe(true);
      const globals = (
        await ctx.request({ method: 'GET', url: '/api/memories?scope=global&q=mine' })
      ).json().items;
      expect(globals).toHaveLength(0);
      await d.close();
    });
  });
});

describe('hindsight store when hindsight fails', () => {
  it('answers 503 to the board and a readable error to agents instead of a 500', async () => {
    const store = new HindsightMemoryStore(
      new HindsightClient({ baseUrl: 'http://127.0.0.1:9', bank: 'down', timeoutMs: 2000 }),
    );
    const ctx = await createTestContext({ memoryStore: store });
    try {
      const list = await ctx.request({ method: 'GET', url: '/api/memories?q=anything' });
      expect(list.statusCode).toBe(503);
      expect(list.json()).toMatchObject({ error: 'memory_unavailable' });
      const create = await ctx.request({
        method: 'POST',
        url: '/api/memories',
        payload: { scope: 'global', title: 'x', body: 'y' },
      });
      expect(create.statusCode).toBe(503);
    } finally {
      await ctx.close();
    }
  });
});

describe('hindsight store when its LLM is rate-limited', () => {
  it('passes a 429 from hindsight on as 503 memory_unavailable', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end('{"detail":"rate limited"}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const store = new HindsightMemoryStore(
      new HindsightClient({ baseUrl: `http://127.0.0.1:${port}`, bank: 'limited' }),
    );
    const ctx = await createTestContext({ memoryStore: store });
    try {
      const create = await ctx.request({
        method: 'POST',
        url: '/api/memories',
        payload: { scope: 'global', title: 'x', body: 'y' },
      });
      expect(create.statusCode).toBe(503);
      expect(create.json().details.cause).toContain('429');
    } finally {
      await ctx.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
