import { ObjectId } from 'mongodb';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { issueKeySchema, type Author, type IssueStatus } from '@conclavix/core';
import type { Collections, CommentDoc, Database, IssueDoc } from '../../db.js';
import { unprocessable } from '../../errors.js';
import { IssueRepository } from '../issues/repository.js';
import { forbidden, isBelowOwnIssue, readableIssue, type RunScope } from './scope.js';
import { guarded } from './results.js';

const MAX_TREE_DEPTH = 20;
const MAX_TREE_ISSUES = 200;
const MAX_LISTED_DOCUMENTS = 200;
const MAX_SCANNED_DOCUMENTS = 1000;
export const MAX_BLOCKERS = 20;
/** Agent reopens per issue; after that only the board can reopen it. */
export const MAX_AGENT_REOPENS = 3;
const REOPENABLE: readonly IssueStatus[] = ['done', 'cancelled', 'in_review'];

type Relation = 'own' | 'parent' | 'sub-issue';
type TreeIssue = Pick<IssueDoc, '_id' | 'key' | 'title' | 'parentId'> & { relation: Relation };

const treeProjection = { key: 1, title: 1, parentId: 1 } as const;

/** The run's issue, its parents (nearest first) and its sub-issues (breadth first), bounded. */
async function issueTree(
  collections: Collections,
  scope: RunScope,
): Promise<{ issues: TreeIssue[]; truncated: boolean }> {
  const issues: TreeIssue[] = [{ ...scope.issue, relation: 'own' }];
  let parentId = scope.issue.parentId;
  for (let depth = 0; parentId && depth < MAX_TREE_DEPTH; depth += 1) {
    const parent = await collections.issues.findOne(
      { _id: parentId },
      { projection: treeProjection },
    );
    if (!parent) {
      break;
    }
    issues.push({ ...parent, relation: 'parent' });
    parentId = parent.parentId;
  }
  let frontier = [scope.issue._id];
  let truncated = false;
  for (let depth = 0; frontier.length > 0 && depth < MAX_TREE_DEPTH; depth += 1) {
    const room = MAX_TREE_ISSUES - issues.length;
    const children = await collections.issues
      .find({ parentId: { $in: frontier } }, { projection: treeProjection })
      .sort({ _id: 1 })
      .limit(room + 1)
      .toArray();
    if (children.length > room) {
      truncated = true;
    }
    const kept = children.slice(0, room);
    issues.push(...kept.map((child) => ({ ...child, relation: 'sub-issue' as const })));
    frontier = kept.map((child) => child._id);
  }
  return { issues, truncated: truncated || frontier.length > 0 };
}

/** Resolve sibling sub-issue keys (same parent: the run's issue) to blocker ids for a new sub-issue. */
export async function siblingBlockerIds(
  collections: Collections,
  scope: RunScope,
  keys: string[],
): Promise<string[]> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) {
    return [];
  }
  const found = await collections.issues
    .find(
      { key: { $in: unique }, projectId: scope.issue.projectId },
      { projection: { key: 1, parentId: 1 } },
    )
    .toArray();
  const byKey = new Map(found.map((issue) => [issue.key, issue]));
  for (const key of unique) {
    const issue = byKey.get(key);
    if (!issue) {
      throw unprocessable(`blockedBy: ${key} does not exist in this project`);
    }
    if (!issue.parentId?.equals(scope.issue._id)) {
      throw forbidden(`blockedBy: ${key} is not a sub-issue of your issue ${scope.issue.key}`);
    }
  }
  return unique.map((key) => (byKey.get(key) as IssueDoc)._id.toHexString());
}

function registerListDocuments(server: McpServer, database: Database, scope: RunScope): void {
  const { collections } = database;
  server.registerTool(
    'list_documents',
    {
      description:
        'List the documents (key, title, revision, issue) of your issue tree: your issue, its ' +
        'parents and all its sub-issues at any depth, so you can read results your reports wrote ' +
        'with read_document. Bounded; truncated is true when the tree or the list was cut.',
    },
    async () =>
      guarded(async () => {
        const tree = await issueTree(collections, scope);
        const order = new Map(tree.issues.map((issue, index) => [issue._id.toHexString(), index]));
        const docs = await collections.documents
          .find({ issueId: { $in: tree.issues.map((issue) => issue._id) } })
          .limit(MAX_SCANNED_DOCUMENTS + 1)
          .toArray();
        const rank = (id: ObjectId): number => order.get(id.toHexString()) ?? Infinity;
        docs.sort((a, b) => rank(a.issueId) - rank(b.issueId) || a.key.localeCompare(b.key));
        const listed = docs.slice(0, MAX_LISTED_DOCUMENTS);
        return {
          documents: listed.map((doc) => {
            const issue = tree.issues[rank(doc.issueId)] as TreeIssue;
            return {
              issueKey: issue.key,
              issueTitle: issue.title,
              relation: issue.relation,
              key: doc.key,
              title: doc.title,
              revision: doc.revision,
              updatedAt: doc.updatedAt,
            };
          }),
          truncated: tree.truncated || docs.length > MAX_LISTED_DOCUMENTS,
        };
      }),
  );
}

function registerReopenIssue(server: McpServer, database: Database, scope: RunScope): void {
  const { collections } = database;
  const issues = new IssueRepository(database);
  const author: Author = { type: 'agent', agentId: scope.agent._id.toHexString() };
  const assertReopenable = (issue: IssueDoc): void => {
    if (!REOPENABLE.includes(issue.status)) {
      throw unprocessable(
        `only done, cancelled or in_review issues can be reopened (${issue.key} is ${issue.status})`,
      );
    }
    if ((issue.agentReopens ?? 0) >= MAX_AGENT_REOPENS) {
      throw unprocessable(
        `${issue.key} was reopened by agents ${MAX_AGENT_REOPENS} times already; ask the board`,
      );
    }
  };
  server.registerTool(
    'reopen_issue',
    {
      description:
        'Send a sub-issue below your issue (direct or deeper) back to work: a done, cancelled or ' +
        'in_review sub-issue goes back to todo on the same branch, with your reason as a comment, ' +
        `and its assignee is woken. At most ${MAX_AGENT_REOPENS} agent reopens per issue; then ask the board.`,
      inputSchema: {
        ref: issueKeySchema.describe('Key of the sub-issue to reopen'),
        reason: z
          .string()
          .trim()
          .min(1)
          .max(20000)
          .describe('What must change; posted as a comment on the sub-issue'),
      },
    },
    async ({ ref, reason }) =>
      guarded(async () => {
        const target = await readableIssue(collections, scope, ref);
        if (!(await isBelowOwnIssue(collections, scope, target._id))) {
          throw forbidden('you can reopen only sub-issues below your issue');
        }
        assertReopenable(target);
        return issues.update(target.key, { status: 'todo' }, async (session, before) => {
          if (!(await isBelowOwnIssue(collections, scope, before._id, session))) {
            throw forbidden('you can reopen only sub-issues below your issue');
          }
          assertReopenable(before);
          await collections.issues.updateOne(
            { _id: before._id },
            { $inc: { agentReopens: 1 } },
            { session },
          );
          await collections.issues.updateOne(
            { _id: scope.issue._id },
            { $inc: { progress: 1 } },
            { session },
          );
          const comment: CommentDoc = {
            _id: new ObjectId(),
            issueId: before._id,
            author,
            body: `Reopened by ${scope.agent.name} from ${scope.issue.key}:\n\n${reason}`,
            createdAt: new Date(),
          };
          await collections.comments.insertOne(comment, { session });
        });
      }),
  );
}

/** Tools for working across an issue tree: documents of sub-issues and reopening them. */
export function registerCollaborationTools(
  server: McpServer,
  database: Database,
  scope: RunScope,
): void {
  registerListDocuments(server, database, scope);
  registerReopenIssue(server, database, scope);
}
