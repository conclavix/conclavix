import { ObjectId, type ClientSession } from 'mongodb';
import type { CreateProjectInput, Issue, Project } from '@conclavix/core';
import type { ChatDoc, ChatRunDoc, Database } from '../../db.js';
import { AppError, conflict, notFound } from '../../errors.js';
import type { AuditLog } from '../audit/audit.js';
import { IssueRepository } from '../issues/repository.js';
import { PLANNING_LABEL } from '../org/planning.js';
import { ProjectRepository } from '../projects/repository.js';

const forbidden = (message: string): AppError => new AppError(403, 'forbidden', message);

/** The chat of a run, re-read in the transaction; only the run answering the chat may act on it. */
async function chatOfRun(
  database: Database,
  run: ChatRunDoc,
  session: ClientSession,
): Promise<ChatDoc> {
  const chat = await database.collections.chats.findOne({ _id: run.chatId }, { session });
  if (!chat) {
    throw notFound('Chat');
  }
  if (!chat.activeRunId?.equals(run._id)) {
    throw forbidden('only the run answering the chat can act on it');
  }
  return chat;
}

/**
 * The approval gate of the creation tools: they work only after the board approved a plan
 * revision, and each of them once per chat.
 */
function assertApproved(chat: ChatDoc, tool: string): void {
  if (chat.status !== 'approved' || chat.approval === null) {
    throw forbidden(
      `${tool} is refused until the board approves the plan with "Approve plan"; ` +
        'keep discussing and keep the plan current with write_chat_plan',
    );
  }
}

/** Replace the chat's plan document with a new revision; refused once the plan was approved. */
export async function writeChatPlan(
  database: Database,
  run: ChatRunDoc,
  markdown: string,
): Promise<{ revision: number }> {
  const { collections } = database;
  return database.inTransaction(async (session) => {
    const chat = await chatOfRun(database, run, session);
    if (chat.status !== 'open') {
      throw conflict(
        chat.status === 'approved'
          ? `the board approved plan revision ${chat.approval?.planRevision ?? '?'}; the plan is frozen`
          : 'the chat is archived',
      );
    }
    const now = new Date();
    const revision = (chat.plan?.revision ?? 0) + 1;
    await collections.chatPlanRevisions.insertOne(
      { _id: new ObjectId(), chatId: chat._id, revision, markdown, runId: run._id, createdAt: now },
      { session },
    );
    await collections.chats.updateOne(
      { _id: chat._id },
      { $set: { plan: { revision, markdown, runId: run._id, updatedAt: now }, updatedAt: now } },
      { session },
    );
    return { revision };
  });
}

const auditDetails = (chat: ChatDoc, run: ChatRunDoc, agentName: string) => ({
  chatId: chat._id.toHexString(),
  chat: chat.title,
  runId: run._id.toHexString(),
  agentId: run.agentId.toHexString(),
  agent: agentName,
  planRevision: chat.approval?.planRevision ?? null,
  approvedBy: chat.approval?.userId ?? null,
});

/** Create the project of an approved plan; once per chat. */
export async function createChatProject(
  database: Database,
  audit: AuditLog,
  run: ChatRunDoc,
  agentName: string,
  input: Pick<CreateProjectInput, 'key' | 'name' | 'description'>,
): Promise<Project> {
  const projects = new ProjectRepository(database.collections);
  return database.inTransaction(async (session) => {
    const chat = await chatOfRun(database, run, session);
    assertApproved(chat, 'create_project');
    if (chat.createdProjectId || chat.createdIssueId) {
      throw conflict('this chat already created its project; create_project works once per plan');
    }
    const project = await projects.create({ ...input, autoPlan: false }, session);
    const marked = await database.collections.chats.updateOne(
      { _id: chat._id, createdProjectId: null },
      { $set: { createdProjectId: new ObjectId(project.id), updatedAt: new Date() } },
      { session },
    );
    if (marked.modifiedCount !== 1) {
      throw conflict('this chat already created its project; create_project works once per plan');
    }
    await audit.write(
      {
        action: 'chat.project_created',
        actor: { type: 'system' },
        details: {
          ...auditDetails(chat, run, agentName),
          projectId: project.id,
          projectKey: project.key,
        },
      },
      session,
    );
    return project;
  });
}

/**
 * Create the initial planning issue of an approved plan, assigned to the lead, in the project the
 * chat created or referenced; once per chat. The issue wakes the lead like any assignment.
 */
export async function createChatPlanningIssue(
  database: Database,
  audit: AuditLog,
  run: ChatRunDoc,
  agentName: string,
  input: { projectId: string; title: string; description: string },
): Promise<Issue> {
  const issues = new IssueRepository(database);
  return database.inTransaction(async (session) => {
    const chat = await chatOfRun(database, run, session);
    assertApproved(chat, 'create_planning_issue');
    if (chat.createdIssueId) {
      throw conflict(
        'this chat already created its planning issue; create_planning_issue works once per plan',
      );
    }
    const projectId = new ObjectId(input.projectId);
    const allowed = [chat.createdProjectId, chat.projectId].filter(
      (id): id is ObjectId => id !== null,
    );
    if (!allowed.some((id) => id.equals(projectId))) {
      throw forbidden(
        allowed.length === 0
          ? 'create the project with create_project first'
          : 'the planning issue belongs in the project this chat created or is about',
      );
    }
    const issue = await issues.create(
      {
        projectId: input.projectId,
        title: input.title,
        description: input.description,
        status: 'todo',
        priority: 'medium',
        parentId: null,
        assigneeAgentId: run.agentId.toHexString(),
        blockedBy: [],
        labels: [PLANNING_LABEL],
      },
      undefined,
      session,
    );
    const marked = await database.collections.chats.updateOne(
      { _id: chat._id, createdIssueId: null },
      { $set: { createdIssueId: new ObjectId(issue.id), updatedAt: new Date() } },
      { session },
    );
    if (marked.modifiedCount !== 1) {
      throw conflict('this chat already created its planning issue');
    }
    await audit.write(
      {
        action: 'chat.issue_created',
        actor: { type: 'system' },
        details: {
          ...auditDetails(chat, run, agentName),
          projectId: input.projectId,
          issueId: issue.id,
          issueKey: issue.key,
        },
      },
      session,
    );
    return issue;
  });
}
