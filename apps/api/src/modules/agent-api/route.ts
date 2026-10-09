import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isChatRun, type Database } from '../../db.js';
import { AuditLog } from '../audit/audit.js';
import { registerChatTools } from './chat-tools.js';
import { resolveRunToken } from '../runs/tokens.js';
import { loadChatScope, loadScope } from './scope.js';
import { registerAgentTools } from './tools.js';
import { registerMemoryTools } from './memory-tools.js';
import { registerCodeTools } from './code-tools.js';
import type { MemoryService } from '../memory/service.js';
import { registerGitTools } from './git-tools.js';
import type { Workspace } from '../workspace/service.js';

const unauthorized = { error: 'unauthorized', message: 'Missing, invalid or expired run token' };

/**
 * Mount the agent API: a stateless MCP endpoint authenticated by a run token. The read-only code
 * tools are served when a project workspace is configured, the git integration tools in addition
 * to agents with the `gitIntegration` permission.
 */
export function registerAgentApi(
  app: FastifyInstance,
  database: Database,
  version: string,
  memories: MemoryService,
  workspace: Workspace | null = null,
): void {
  const audit = new AuditLog(database.collections, app.log);
  app.post('/mcp', async (request, reply) => {
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    const run = token ? await resolveRunToken(database.collections, token, new Date()) : null;
    if (!run) {
      return reply.status(401).send(unauthorized);
    }
    const server = new McpServer({ name: 'conclavix', version });
    if (isChatRun(run)) {
      const scope = await loadChatScope(database, run);
      registerChatTools(server, database, scope, memories, audit, workspace);
    } else {
      const scope = await loadScope(database, run);
      registerAgentTools(server, database, scope);
      registerMemoryTools(server, memories, () => ({
        agentId: scope.agent._id.toHexString(),
        projectId: scope.issue.projectId.toHexString(),
      }));
      if (workspace) {
        registerCodeTools(server, database, scope, workspace);
        if (scope.agent.gitIntegration === true) {
          registerGitTools(server, database, scope, workspace, audit);
        }
      }
    }
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closing ??= Promise.all(
        [transport, server].map(async (resource) => {
          try {
            await resource.close();
          } catch (error) {
            request.log.error(
              { err: error, runId: run._id.toHexString() },
              'failed to close MCP resource',
            );
          }
        }),
      ).then(() => {});
      return closing;
    };
    reply.raw.once('close', () => void close());
    reply.hijack();
    try {
      await server.connect(transport as Parameters<McpServer['connect']>[0]);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      request.log.error({ err: error, runId: run._id.toHexString() }, 'MCP request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify({ error: 'internal_server_error' }));
      } else if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
      await close();
    }
  });

  for (const method of ['GET', 'DELETE'] as const) {
    app.route({
      method,
      url: '/mcp',
      handler: async (_request, reply) =>
        reply.status(405).send({ error: 'method_not_allowed', message: 'Use POST' }),
    });
  }
}
