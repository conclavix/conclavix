import { ObjectId } from 'mongodb';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  MAX_DECISION_OPTIONS,
  documentKeySchema,
  idSchema,
  issueKeySchema,
  requestBoardDecisionSchema,
  type Author,
} from '@conclavix/core';
import type { AgentDoc, Database } from '../../db.js';
import { projectAccessChecker } from '../projects/agent-access.js';
import { CommentRepository } from '../comments/repository.js';
import { DocumentRepository } from '../documents/repository.js';
import { toIssue } from '../issues/mapping.js';
import { IssueRepository } from '../issues/repository.js';
import { DecisionService } from '../decisions/service.js';
import { linkedAgents } from '../org/links.js';
import { toAgentSummary } from '../org/repository.js';
import {
  assertCanDelegateTo,
  forbidden,
  isInOwnIssueTree,
  readableIssue,
  type RunScope,
} from './scope.js';
import { guarded } from './results.js';
import { registerLeadTools, registerNotificationTools } from './org-tools.js';
import { MAX_BLOCKERS, registerCollaborationTools, siblingBlockerIds } from './collab-tools.js';

interface ToolContext {
  server: McpServer;
  database: Database;
  scope: RunScope;
  issues: IssueRepository;
  comments: CommentRepository;
  documents: DocumentRepository;
  author: Author;
  own: string;
}

/** Reading the issue, commenting and moving its status. */
function registerIssueTools({
  server,
  database,
  scope,
  issues,
  comments,
  documents,
  author,
  own,
}: ToolContext): void {
  const { collections } = database;
  server.registerTool(
    'get_issue',
    {
      description:
        'Read an issue in your project (default: the issue this run is for), with its latest comments and documents.',
      inputSchema: {
        ref: issueKeySchema.optional().describe('Issue key like CVX-12; omit for your own issue'),
      },
    },
    async ({ ref }) =>
      guarded(async () => {
        const issue = await readableIssue(collections, scope, ref);
        const [thread, docs, children] = await Promise.all([
          comments.list(issue.key, { limit: 50 }),
          documents.list(issue.key),
          collections.issues.find({ parentId: issue._id }).sort({ _id: 1 }).limit(100).toArray(),
        ]);
        return {
          issue: toIssue(issue),
          comments: thread.items,
          documents: docs,
          children: children.map((child) => ({
            key: child.key,
            title: child.title,
            status: child.status,
          })),
        };
      }),
  );
  server.registerTool(
    'add_comment',
    {
      description:
        'Comment on your issue: report progress or explain a decision. To ask the board for a ' +
        'decision use request_board_decision instead.',
      inputSchema: { body: z.string().trim().min(1).max(20000) },
    },
    async ({ body }) => guarded(() => comments.create(own, { body }, author)),
  );
  server.registerTool(
    'set_status',
    {
      description:
        'Move your issue forward: done when finished, in_review while it waits for something ' +
        'other than a board decision (e.g. sub-issues or a review). When you need the board to ' +
        'decide, use request_board_decision instead.',
      inputSchema: { status: z.enum(['in_progress', 'in_review', 'done']) },
    },
    async ({ status }) => guarded(() => issues.update(own, { status })),
  );
}

/** Asking the board for a decision, instead of a bare in_review. */
function registerDecisionTools({ server, database, scope }: ToolContext): void {
  server.registerTool(
    'request_board_decision',
    {
      description:
        'Ask the board to decide something you cannot or must not decide yourself. Sets your ' +
        'issue to in_review, posts the question as your comment and lists it on the board under ' +
        'Decisions. The board answers by picking one of your options or writing an answer; that ' +
        'moves the issue back to in_progress and wakes you with the answer as a comment. Stop ' +
        'this run after asking. Asking again replaces your open question.',
      inputSchema: {
        question: requestBoardDecisionSchema.shape.question.describe(
          'The decision needed, with the context the board needs to answer it',
        ),
        options: requestBoardDecisionSchema.shape.options.describe(
          `Up to ${MAX_DECISION_OPTIONS} short, distinct answers the board can pick from; omit for a free-text answer`,
        ),
      },
    },
    async ({ question, options }) =>
      guarded(() =>
        new DecisionService(database).request(
          { agent: scope.agent, issue: scope.issue, runId: scope.run._id },
          { question, options },
        ),
      ),
  );
}

/** Seeing one's team and handing work down to it. */
function registerDelegationTools({ server, database, scope, issues }: ToolContext): void {
  const { collections } = database;
  server.registerTool(
    'list_team',
    {
      description:
        'List the agents you can delegate to in this project (canDelegateTo: only these, one hop, ' +
        'no further down), linked agents that are not enabled in this project (notInThisProject: ' +
        'do not assign them work here) and the agents you report to (reportsTo: they are told ' +
        'when your delegated work closes).',
    },
    async () =>
      guarded(async () => {
        const [delegates, reportTargets, access] = await Promise.all([
          linkedAgents(collections, scope.agent._id, 'delegates', 'outgoing'),
          linkedAgents(collections, scope.agent._id, 'reports', 'outgoing'),
          projectAccessChecker(collections, scope.issue.projectId),
        ]);
        const summary = (agent: AgentDoc) => ({ ...toAgentSummary(agent), status: agent.status });
        return {
          canDelegateTo: delegates.filter(access.isEnabled).map(summary),
          notInThisProject: delegates.filter((agent) => !access.isEnabled(agent)).map(summary),
          reportsTo: reportTargets.map(toAgentSummary),
        };
      }),
  );
  server.registerTool(
    'create_subissue',
    {
      description:
        'Split off part of your issue as a sub-issue, optionally assigned to yourself or to an agent in ' +
        'list_team canDelegateTo. When it closes you are woken on this issue if it is still yours to work ' +
        'on, otherwise you get a notification. blockedBy: keys of other sub-issues of your issue that ' +
        'must close first; the assignee is woken once all of them are done or cancelled.',
      inputSchema: {
        title: z.string().trim().min(1).max(200),
        description: z.string().max(50000).default(''),
        assigneeAgentId: idSchema.optional(),
        blockedBy: z
          .array(issueKeySchema)
          .max(MAX_BLOCKERS)
          .default([])
          .describe('Keys of sibling sub-issues (same parent: your issue) this one waits for'),
      },
    },
    async ({ title, description, assigneeAgentId, blockedBy }) =>
      guarded(async () => {
        if (assigneeAgentId) {
          await assertCanDelegateTo(collections, scope, new ObjectId(assigneeAgentId));
        }
        const blockerIds = await siblingBlockerIds(collections, scope, blockedBy);
        return issues.create(
          {
            projectId: scope.issue.projectId.toHexString(),
            title,
            description,
            status: 'todo',
            priority: scope.issue.priority,
            parentId: scope.issue._id.toHexString(),
            assigneeAgentId: assigneeAgentId ?? null,
            blockedBy: blockerIds,
            labels: [],
          },
          { by: scope.agent._id, fromIssueId: scope.issue._id },
        );
      }),
  );
}

/** Reading and writing versioned documents. */
function registerDocumentTools({
  server,
  database,
  scope,
  documents,
  author,
  own,
}: ToolContext): void {
  const { collections } = database;
  server.registerTool(
    'read_document',
    {
      description:
        'Read a document in your issue tree: your issue, its parents, or its sub-issues at any ' +
        'depth (results your reports wrote). list_documents shows what exists.',
      inputSchema: {
        key: documentKeySchema,
        ref: issueKeySchema
          .optional()
          .describe('Issue key of a parent issue or sub-issue; omit for your own issue'),
        revision: z.int().min(1).optional(),
      },
    },
    async ({ key, ref, revision }) =>
      guarded(async () => {
        const issue = await readableIssue(collections, scope, ref);
        if (!(await isInOwnIssueTree(collections, scope, issue._id))) {
          throw forbidden(
            'documents are readable in your issue tree only: your issue, its parents and sub-issues',
          );
        }
        return documents.get(issue.key, key, revision);
      }),
  );
  server.registerTool(
    'write_document',
    {
      description:
        'Create or update a document on your issue. To update, pass the revision you read as baseRevision.',
      inputSchema: {
        key: documentKeySchema,
        body: z.string().max(200000),
        title: z.string().trim().min(1).max(200).optional(),
        baseRevision: z.int().min(1).optional(),
      },
    },
    async ({ key, body, title, baseRevision }) =>
      guarded(async () => {
        const input = {
          body,
          ...(title === undefined ? {} : { title }),
          ...(baseRevision === undefined ? {} : { baseRevision }),
        };
        return (await documents.write(own, key, input, author)).document;
      }),
  );
}

/** Register the tools a run's agent may use, all bound to the run's scope. */
export function registerAgentTools(server: McpServer, database: Database, scope: RunScope): void {
  const context: ToolContext = {
    server,
    database,
    scope,
    issues: new IssueRepository(database),
    comments: new CommentRepository(database),
    documents: new DocumentRepository(database),
    author: { type: 'agent', agentId: scope.agent._id.toHexString() },
    own: scope.issue.key,
  };
  registerIssueTools(context);
  registerDecisionTools(context);
  registerDelegationTools(context);
  registerDocumentTools(context);
  registerNotificationTools(server, database, scope);
  registerCollaborationTools(server, database, scope);
  if (scope.isLead) {
    registerLeadTools(server, database, scope);
  }
}
