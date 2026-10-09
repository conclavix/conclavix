import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CHAT_LIMITS, idSchema, projectKeySchema } from '@conclavix/core';
import type { Database } from '../../db.js';
import type { AuditLog } from '../audit/audit.js';
import {
  createChatPlanningIssue,
  createChatProject,
  writeChatPlan,
} from '../chats/agent-actions.js';
import type { MemoryService } from '../memory/service.js';
import type { RepoReader } from '../workspace/reader.js';
import { registerProjectCodeTools } from './code-tools.js';
import { registerMemoryTools } from './memory-tools.js';
import { registerLeadReadTools } from './org-tools.js';
import { guarded } from './results.js';
import type { ChatScope } from './scope.js';

/** The tools only a chat run has: the plan document and the approval-gated creation tools. */
function registerPlanTools(
  server: McpServer,
  database: Database,
  audit: AuditLog,
  scope: ChatScope,
): void {
  server.registerTool(
    'write_chat_plan',
    {
      description:
        "Replace the chat's plan document (Markdown) with a new revision: goal, scope, acceptance " +
        'criteria, work packages, risks, open questions. The board approves a revision of it. ' +
        'Refused once the plan was approved.',
      inputSchema: { markdown: z.string().trim().min(1).max(CHAT_LIMITS.plan) },
    },
    async ({ markdown }) => guarded(() => writeChatPlan(database, scope.run, markdown)),
  );
  server.registerTool(
    'create_project',
    {
      description:
        'Create the new project of the approved plan. Refused until the board approved the plan, ' +
        'and after this chat created its project once.',
      inputSchema: {
        key: projectKeySchema,
        name: z.string().trim().min(1).max(120),
        description: z.string().max(2000).default(''),
      },
    },
    async (input) =>
      guarded(() => createChatProject(database, audit, scope.run, scope.agent.name, input)),
  );
  server.registerTool(
    'create_planning_issue',
    {
      description:
        'Create the initial planning issue of the approved plan, assigned to you, in the project ' +
        'this chat created (create_project) or is about. Describe the approved plan in it; you ' +
        'are woken on it to plan the work. Refused until the board approved the plan, and after ' +
        'this chat created its planning issue once.',
      inputSchema: {
        projectId: idSchema,
        title: z.string().trim().min(1).max(200),
        description: z.string().max(50000).default(''),
      },
    },
    async (input) =>
      guarded(() => createChatPlanningIssue(database, audit, scope.run, scope.agent.name, input)),
  );
}

/**
 * The tools of a lead's chat run: memory, the lead's project reads, the read-only code tools of a
 * referenced project, the plan document and the approval-gated creation tools. No issue tools:
 * the run belongs to no issue, and nothing but the approved plan may create work.
 */
export function registerChatTools(
  server: McpServer,
  database: Database,
  scope: ChatScope,
  memories: MemoryService,
  audit: AuditLog,
  reader: RepoReader | null,
): void {
  const projectId = scope.chat.projectId?.toHexString() ?? null;
  registerMemoryTools(
    server,
    memories,
    () => ({ agentId: scope.agent._id.toHexString(), projectId }),
    { hasProject: projectId !== null },
  );
  registerLeadReadTools(server, database, scope.agent._id);
  if (reader && scope.chat.projectId) {
    registerProjectCodeTools(
      server,
      database,
      { agent: scope.agent, projectId: scope.chat.projectId },
      reader,
    );
  }
  registerPlanTools(server, database, audit, scope);
}
