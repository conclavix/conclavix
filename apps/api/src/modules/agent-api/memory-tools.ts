import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MemoryService } from '../memory/service.js';
import type { RunScope } from './scope.js';

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

/** Memory tools for a run: read global, project and own memory; write project and own. */
export function registerMemoryTools(
  server: McpServer,
  memories: MemoryService,
  scope: RunScope,
): void {
  const context = () => ({
    agentId: scope.agent._id.toHexString(),
    projectId: scope.issue.projectId.toHexString(),
  });

  server.registerTool(
    'memory_search',
    {
      description:
        "Search what the organisation has learned: global house rules, this project's decisions and pitfalls, " +
        'and your own notes. Search before you start on something non-trivial.',
      inputSchema: {
        query: z
          .string()
          .trim()
          .max(500)
          .default('')
          .describe('Words to search for; empty lists the newest'),
        scope: z.enum(['global', 'project', 'agent', 'all']).default('all'),
        limit: z.int().min(1).max(20).default(8),
      },
    },
    async ({ query, scope: searchScope, limit }) => {
      const found = await memories.agentSearch(context(), query, searchScope, limit);
      return text(
        found.map((memory) => ({
          id: memory.id,
          scope: memory.scope,
          title: memory.title,
          body: memory.body,
          tags: memory.tags,
          updatedAt: memory.updatedAt,
        })),
      );
    },
  );

  server.registerTool(
    'memory_save',
    {
      description:
        'Record something that will still matter later: a decision, a pitfall, a rule, how to reach something. ' +
        'Not progress reports. scope "project" is shared with everyone on this project, "agent" is only yours. ' +
        'Saving the same title again updates that entry instead of adding a new one.',
      inputSchema: {
        scope: z.enum(['project', 'agent']),
        title: z.string().trim().min(1).max(200),
        body: z.string().trim().min(1).max(20000),
        tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
      },
    },
    async (input) => {
      const { memory, created } = await memories.agentSave(context(), input);
      return text({
        id: memory.id,
        scope: memory.scope,
        title: memory.title,
        revision: memory.revision,
        created,
      });
    },
  );
}
