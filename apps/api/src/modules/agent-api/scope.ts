import type { ClientSession, ObjectId } from 'mongodb';
import type {
  AgentDoc,
  ChatDoc,
  ChatRunDoc,
  Collections,
  Database,
  IssueDoc,
  IssueRunDoc,
  RunDoc,
} from '../../db.js';
import { isLead } from '../org/lead.js';
import { delegatesTo } from '../org/links.js';
import { AppError } from '../../errors.js';
import { findIssueByRef } from '../issues/queries.js';

const MAX_DEPTH = 20;

const forbidden = (message: string): AppError => new AppError(403, 'forbidden', message);

/** What a run may touch: its agent, its issue and that issue's project; the lead plans more. */
export interface RunScope {
  run: IssueRunDoc;
  agent: AgentDoc;
  issue: IssueDoc;
  isLead: boolean;
}

/** Load the agent and issue a run belongs to, and whether the agent is the lead. */
export async function loadScope(database: Database, run: RunDoc): Promise<RunScope> {
  const { collections } = database;
  const [agent, issue] = await Promise.all([
    collections.agents.findOne({ _id: run.agentId }),
    run.issueId ? collections.issues.findOne({ _id: run.issueId }) : null,
  ]);
  if (!agent || !issue) {
    throw forbidden('the run no longer has an agent or issue');
  }
  return {
    run: { ...run, issueId: issue._id },
    agent,
    issue,
    isLead: await isLead(database, agent._id),
  };
}

/** What a chat run may touch: its chat, the lead's planning reads and the gated creation tools. */
export interface ChatScope {
  run: ChatRunDoc;
  agent: AgentDoc;
  chat: ChatDoc;
}

/** Load the agent and chat of a chat run. */
export async function loadChatScope(database: Database, run: ChatRunDoc): Promise<ChatScope> {
  const { collections } = database;
  const [agent, chat] = await Promise.all([
    collections.agents.findOne({ _id: run.agentId }),
    collections.chats.findOne({ _id: run.chatId }),
  ]);
  if (!agent || !chat) {
    throw forbidden('the run no longer has an agent or chat');
  }
  return { run, agent, chat };
}

/** Resolve an issue the run may read: any issue in the run's project, default its own. */
export async function readableIssue(
  collections: Collections,
  scope: RunScope,
  ref: string | undefined,
): Promise<IssueDoc> {
  if (!ref) {
    return scope.issue;
  }
  const issue = await findIssueByRef(collections, ref);
  if (!issue.projectId.equals(scope.issue.projectId)) {
    throw forbidden('issues outside the project of this run are not readable');
  }
  return issue;
}

/** True if `ancestorId` is the run's issue itself or one of its parents. */
export async function isOwnIssueOrAncestor(
  collections: Collections,
  scope: RunScope,
  issueId: ObjectId,
): Promise<boolean> {
  let current: Pick<IssueDoc, '_id' | 'parentId'> | null = scope.issue;
  for (let depth = 0; current && depth <= MAX_DEPTH; depth += 1) {
    if (current._id.equals(issueId)) {
      return true;
    }
    current = current.parentId
      ? await collections.issues.findOne({ _id: current.parentId }, { projection: { parentId: 1 } })
      : null;
  }
  return false;
}

/** True if the issue lies below the run's issue: a direct or transitive sub-issue (parentId). */
export async function isBelowOwnIssue(
  collections: Collections,
  scope: RunScope,
  issueId: ObjectId,
  session?: ClientSession,
): Promise<boolean> {
  const options = { projection: { parentId: 1 }, ...(session ? { session } : {}) };
  let current = await collections.issues.findOne({ _id: issueId }, options);
  for (let depth = 0; current?.parentId && depth <= MAX_DEPTH; depth += 1) {
    if (current.parentId.equals(scope.issue._id)) {
      return true;
    }
    current = await collections.issues.findOne({ _id: current.parentId }, options);
  }
  return false;
}

/** True if the issue is in the run's issue tree: the issue itself, a parent or a sub-issue. */
export async function isInOwnIssueTree(
  collections: Collections,
  scope: RunScope,
  issueId: ObjectId,
): Promise<boolean> {
  return (
    (await isOwnIssueOrAncestor(collections, scope, issueId)) ||
    (await isBelowOwnIssue(collections, scope, issueId))
  );
}

/** Reject delegation to anyone but the agent itself or an agent it has a direct `delegates` link to. */
export async function assertCanDelegateTo(
  collections: Collections,
  scope: RunScope,
  assigneeId: ObjectId,
): Promise<void> {
  if (assigneeId.equals(scope.agent._id)) {
    return;
  }
  if (!(await delegatesTo(collections, scope.agent._id, assigneeId))) {
    throw forbidden('you can only delegate to agents you have a link to (see list_team)');
  }
}

export { forbidden };
