import Fastify from 'fastify';
import { ObjectId } from 'mongodb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Database } from '../src/db.js';
import { registerAgentApi } from '../src/modules/agent-api/route.js';
import type { MemoryService } from '../src/modules/memory/service.js';

vi.mock('../src/modules/runs/tokens.js', () => ({
  resolveRunToken: vi.fn(async () => ({ _id: new ObjectId() })),
}));
vi.mock('../src/modules/agent-api/scope.js', () => ({ loadScope: vi.fn(async () => ({})) }));
vi.mock('../src/modules/agent-api/tools.js', () => ({ registerAgentTools: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

describe('MCP request failures after hijacking', () => {
  it.each(['connect', 'handleRequest'] as const)(
    'handles %s rejection and closes both resources',
    async (method) => {
      const connect = vi.spyOn(McpServer.prototype, 'connect').mockResolvedValue(undefined);
      const handle = vi
        .spyOn(StreamableHTTPServerTransport.prototype, 'handleRequest')
        .mockResolvedValue(undefined);
      (method === 'connect' ? connect : handle).mockRejectedValueOnce(new Error('request failed'));
      const transportClose = vi
        .spyOn(StreamableHTTPServerTransport.prototype, 'close')
        .mockRejectedValue(new Error('transport close failed'));
      const serverClose = vi
        .spyOn(McpServer.prototype, 'close')
        .mockRejectedValue(new Error('server close failed'));
      const logs: string[] = [];
      const app = Fastify({
        logger: {
          stream: {
            write: (line: string) => {
              logs.push(line);
            },
          },
        },
      });
      registerAgentApi(app, { collections: {} } as Database, 'test', {} as MemoryService);
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/mcp',
          headers: { authorization: 'Bearer test' },
          payload: {},
        });
        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual({ error: 'internal_server_error' });
        await vi.waitFor(() => expect(serverClose).toHaveBeenCalledOnce());
        expect(transportClose).toHaveBeenCalledOnce();
        const errors = logs.map((line) => JSON.parse(line)).filter((entry) => entry.level === 50);
        expect(errors).toHaveLength(3);
        expect(errors.every((entry) => /^[a-f0-9]{24}$/.test(entry.runId))).toBe(true);
      } finally {
        await app.close();
      }
    },
  );

  it('ends an already started response on request failure', async () => {
    vi.spyOn(McpServer.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(StreamableHTTPServerTransport.prototype, 'handleRequest').mockImplementation(
      async (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.write('started');
        throw new Error('stream failed');
      },
    );
    const transportClose = vi
      .spyOn(StreamableHTTPServerTransport.prototype, 'close')
      .mockResolvedValue(undefined);
    const serverClose = vi.spyOn(McpServer.prototype, 'close').mockResolvedValue(undefined);
    const app = Fastify();
    registerAgentApi(app, { collections: {} } as Database, 'test', {} as MemoryService);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: 'Bearer test' },
        payload: {},
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('started');
      expect(transportClose).toHaveBeenCalledOnce();
      expect(serverClose).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
});
