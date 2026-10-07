import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export interface FakeMcpServer {
  url: string;
  /** Requests seen, with the Authorization header each carried. */
  seen: { method: string; authorization: string | undefined }[];
  close(): Promise<void>;
}

async function body(request: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of request) raw += String(chunk);
  return raw ? JSON.parse(raw) : undefined;
}

/**
 * A streamable-HTTP MCP server on loopback with `tools` tools that answers only requests with
 * `Authorization: <authorization>`; anything else gets 401.
 */
export async function startFakeMcpServer(
  authorization: string,
  tools = 3,
  echoSecretInError = false,
): Promise<FakeMcpServer> {
  const seen: FakeMcpServer['seen'] = [];
  const server: Server = createServer((request, response) => {
    void (async () => {
      const parsed = await body(request);
      const method = (parsed as { method?: string } | undefined)?.method ?? request.method ?? '';
      seen.push({ method, authorization: request.headers.authorization });
      if (request.headers.authorization !== authorization) {
        if (echoSecretInError) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              error: { code: -32000, message: `bad header ${request.headers.authorization}` },
            }),
          );
          return;
        }
        response.writeHead(401).end();
        return;
      }
      const mcp = new McpServer({ name: 'fake-docs', version: '1.2.3' });
      for (let index = 0; index < tools; index += 1) {
        mcp.registerTool(
          `tool_${index}`,
          { description: `Tool ${index}`, inputSchema: { q: z.string().optional() } },
          () => ({ content: [{ type: 'text', text: 'ok' }] }),
        );
      }
      // Stateless: no session id, a fresh server per request.
      const options = { sessionIdGenerator: undefined, enableJsonResponse: true };
      const transport = new StreamableHTTPServerTransport(
        options as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0],
      );
      await mcp.connect(transport as unknown as Parameters<McpServer['connect']>[0]);
      await transport.handleRequest(request, response, parsed);
      response.on('close', () => void transport.close());
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seen,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
