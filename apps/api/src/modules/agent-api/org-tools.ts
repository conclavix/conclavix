import { ObjectId } from 'mongodb';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  CLOSED_ISSUE_STATUSES,
  idSchema,
  issuePrioritySchema,
  projectKeySchema,
} from '@conclavix/core';
import type { Database, ProjectDoc } from '../../db.js';
import { notFound, unprocessable } from '../../errors.js';
import { IssueRepository } from '../issues/repository.js';
import { agentsNotEnabledIn } from '../projects/agent-access.js';
import { isLead } from '../org/lead.js';
import { listNotifications, markNotificationsRead } from '../org/notifications.js';
import { assertCanDelegateTo, forbidden, type RunScope } from './scope.js';
import { guarded } from './results.js';

const MAX_BOARD_ISSUES = 200;

/** Notifications about delegated work, for every agent. */
export function registerNotificationTools(
  server: McpServer,
  database: Database,
  scope: RunScope,
): void {
  const { collections } = database;
  server.registerTool(
    'list_notifications',
    {
      description:
        'List notifications about work you delegated or that agents reporting to you finished. ' +
        'They do not need a reply; mark them read once you have taken them into account.',
      inputSchema: {
        unreadOnly: z.boolean().default(true),
        limit: z.int().min(1).max(50).default(20),
      },
    },
    async ({ unreadOnly, limit }) =>
      guarded(() => listNotifications(collections, scope.agent._id, { unreadOnly, limit })),
  );
  server.registerTool(
    'mark_notifications_read',
    {
      description: 'Mark notifications read; omit ids to mark all of yours read.',
      inputSchema: { ids: z.array(idSchema).min(1).max(100).optional() },
    },
    async ({ ids }) =>
      guarded(async () => ({
        marked: await markNotificationsRead(
          collections,
          scope.agent._id,
          ids?.map((id) => new ObjectId(id)),
        ),
      })),
  );
}

interface LeadReadContext {
  server: McpServer;
  database: Database;
  assertLead(): Promise<void>;
  activeProject(key: string): Promise<ProjectDoc>;
}

interface LeadToolContext extends LeadReadContext {
  scope: RunScope;
}

/** Reading projects and their boards across the organisation. */
function registerProjectReadTools({
  server,
  database,
  assertLead,
  activeProject,
}: LeadReadContext): void {
  const { collections } = database;
  server.registerTool(
    'list_projects',
    {
      description:
        'Lead only. List the active projects with how many open issues each has per status.',
    },
    async () =>
      guarded(async () => {
        await assertLead();
        const projects = await collections.projects
          .find({ status: 'active' })
          .sort({ key: 1 })
          .toArray();
        const counts = await collections.issues
          .aggregate<{ _id: { projectId: ObjectId; status: string }; count: number }>([
            { $match: { status: { $nin: [...CLOSED_ISSUE_STATUSES] } } },
            { $group: { _id: { projectId: '$projectId', status: '$status' }, count: { $sum: 1 } } },
          ])
          .toArray();
        return projects.map((project) => ({
          key: project.key,
          name: project.name,
          description: project.description,
          openIssues: Object.fromEntries(
            counts
              .filter((row) => row._id.projectId.equals(project._id))
              .map((row) => [row._id.status, row.count]),
          ),
        }));
      }),
  );

  server.registerTool(
    'get_project_board',
    {
      description:
        'Lead only. Read the open issues of a project, oldest first, with their assignees, and ' +
        'the agents not enabled in it (agentsNotEnabled: create_issue rejects them there).',
      inputSchema: { projectKey: projectKeySchema },
    },
    async ({ projectKey }) =>
      guarded(async () => {
        await assertLead();
        const project = await activeProject(projectKey);
        const open = await collections.issues
          .find({ projectId: project._id, status: { $nin: [...CLOSED_ISSUE_STATUSES] } })
          .sort({ _id: 1 })
          .limit(MAX_BOARD_ISSUES)
          .toArray();
        const assigneeIds = open.flatMap((issue) =>
          issue.assigneeAgentId ? [issue.assigneeAgentId] : [],
        );
        const agents = await collections.agents
          .find({ _id: { $in: assigneeIds } }, { projection: { name: 1 } })
          .toArray();
        const names = new Map(agents.map((agent) => [agent._id.toHexString(), agent.name]));
        return {
          project: { key: project.key, name: project.name, description: project.description },
          issues: open.map((issue) => ({
            key: issue.key,
            title: issue.title,
            status: issue.status,
            priority: issue.priority,
            parentId: issue.parentId?.toHexString() ?? null,
            assignee: issue.assigneeAgentId
              ? (names.get(issue.assigneeAgentId.toHexString()) ?? null)
              : null,
          })),
          agentsNotEnabled: await agentsNotEnabledIn(collections, project._id),
          truncated: open.length === MAX_BOARD_ISSUES,
        };
      }),
  );
}

/** Creating top-level issues in any active project. */
function registerCreateIssueTool({
  server,
  database,
  scope,
  assertLead,
  activeProject,
}: LeadToolContext): void {
  const { collections } = database;
  const issues = new IssueRepository(database);
  server.registerTool(
    'create_issue',
    {
      description:
        'Lead only. Create a top-level issue in an active project, assigned to yourself or to an agent ' +
        'in list_team canDelegateTo. When it closes you are woken on your current issue if it is still yours to work on, otherwise you get a notification.',
      inputSchema: {
        projectKey: projectKeySchema,
        title: z.string().trim().min(1).max(200),
        description: z.string().max(50000).default(''),
        priority: issuePrioritySchema.default('medium'),
        assigneeAgentId: idSchema.optional(),
      },
    },
    async ({ projectKey, title, description, priority, assigneeAgentId }) =>
      guarded(async () => {
        await assertLead();
        const project = await activeProject(projectKey);
        if (assigneeAgentId) {
          await assertCanDelegateTo(collections, scope, new ObjectId(assigneeAgentId));
        }
        return issues.create(
          {
            projectId: project._id.toHexString(),
            title,
            description,
            status: 'todo',
            priority,
            parentId: null,
            assigneeAgentId: assigneeAgentId ?? null,
            blockedBy: [],
            labels: [],
          },
          { by: scope.agent._id, fromIssueId: scope.issue._id },
        );
      }),
  );
}

function leadContext(server: McpServer, database: Database, agentId: ObjectId) {
  return {
    server,
    database,
    assertLead: async () => {
      if (!(await isLead(database, agentId))) {
        throw forbidden('only the lead agent can plan across projects');
      }
    },
    activeProject: async (key: string) => {
      const project = await database.collections.projects.findOne({ key });
      if (!project) {
        throw notFound('Project');
      }
      if (project.status !== 'active') {
        throw unprocessable('project is archived');
      }
      return project;
    },
  };
}

/**
 * Planning tools for the lead only: they are registered for the lead's runs and every call checks
 * again that the run's agent is still the lead.
 */
export function registerLeadTools(server: McpServer, database: Database, scope: RunScope): void {
  const context: LeadToolContext = { ...leadContext(server, database, scope.agent._id), scope };
  registerProjectReadTools(context);
  registerCreateIssueTool(context);
}

/** list_projects and get_project_board for a lead's chat run, which has no issue. */
export function registerLeadReadTools(
  server: McpServer,
  database: Database,
  agentId: ObjectId,
): void {
  registerProjectReadTools(leadContext(server, database, agentId));
}
