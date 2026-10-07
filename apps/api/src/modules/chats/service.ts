import { ObjectId, type Filter } from 'mongodb';
import type {
  ApproveChatPlanInput,
  Chat,
  ChatMessage,
  ChatPlanRevision,
  CreateChatInput,
  ListChatsQuery,
  PostChatMessageInput,
  UpdateChatInput,
} from '@conclavix/core';
import type { AgentDoc, ChatDoc, ChatMessageDoc, Database } from '../../db.js';
import { conflict, notFound, unprocessable } from '../../errors.js';
import type { AuditLog } from '../audit/audit.js';
import { actorOf, authorOf, type Principal } from '../auth/principal.js';
import { resolveLead, storedLeadId } from '../org/lead.js';
import { costToday } from '../scheduler/gates.js';
import { toChat, toChatMessage, toChatPlanRevision } from './mapping.js';

/** Messages one chat read returns; a planning chat stays far below this. */
const MAX_MESSAGES = 500;

/** The board message that hands the approved plan to the lead. */
export const approvalMessage = (revision: number): string =>
  `Plan revision ${revision} approved. Create the project and the initial planning issue as agreed.`;

/**
 * True while the board may still talk to the lead: during the discussion, and after the approval
 * until the planning issue exists (so the board can ask the lead to retry a failed creation).
 */
export const acceptsMessages = (chat: Pick<ChatDoc, 'status' | 'createdIssueId'>): boolean =>
  chat.status === 'open' || (chat.status === 'approved' && chat.createdIssueId === null);

/**
 * Refuse a chat turn the lead cannot take now: the chat's agent is gone, no longer the lead,
 * paused, or at its daily cost limit. Chat runs count against the lead's cost limits like every
 * other run.
 */
export async function assertLeadCanAnswer(
  database: Database,
  chat: Pick<ChatDoc, 'leadAgentId'>,
  now = new Date(),
): Promise<AgentDoc> {
  const { collections } = database;
  const agent = await collections.agents.findOne({ _id: chat.leadAgentId });
  if (!agent) {
    throw conflict('the lead agent of this chat no longer exists; start a new chat');
  }
  const leadId = await storedLeadId(collections);
  if (!leadId?.equals(agent._id)) {
    throw conflict(`${agent.name} is no longer the lead; start a new chat with the current lead`);
  }
  if (agent.status !== 'active') {
    throw conflict(`${agent.name} is paused; set the agent back to active to continue the chat`);
  }
  if ((await costToday(collections, agent, now)) >= agent.limits.maxCostPerDayUsd) {
    throw conflict(`${agent.name} reached its daily cost limit; the chat continues tomorrow (UTC)`);
  }
  return agent;
}

/** The board's side of chats with the lead: reading, starting, messaging and approving. */
export class ChatService {
  constructor(
    private readonly database: Database,
    private readonly audit: AuditLog,
  ) {}

  private get collections() {
    return this.database.collections;
  }

  private async load(id: ObjectId): Promise<ChatDoc> {
    const chat = await this.collections.chats.findOne({ _id: id });
    if (!chat) {
      throw notFound('Chat');
    }
    return chat;
  }

  /** The chat with the keys of the project and issue its approved plan created. */
  private async view(doc: ChatDoc): Promise<Chat> {
    const [project, issue] = await Promise.all([
      doc.createdProjectId
        ? this.collections.projects.findOne(
            { _id: doc.createdProjectId },
            { projection: { key: 1 } },
          )
        : null,
      doc.createdIssueId
        ? this.collections.issues.findOne({ _id: doc.createdIssueId }, { projection: { key: 1 } })
        : null,
    ]);
    return toChat(doc, { projectKey: project?.key ?? null, issueKey: issue?.key ?? null });
  }

  async list(query: ListChatsQuery): Promise<{ items: Chat[]; nextCursor: string | null }> {
    const filter: Filter<ChatDoc> = {};
    if (query.status) {
      filter.status = query.status;
    }
    if (query.before) {
      filter._id = { $lt: new ObjectId(query.before) };
    }
    const docs = await this.collections.chats
      .find(filter)
      .sort({ _id: -1 })
      .limit(query.limit + 1)
      .toArray();
    const items = docs.slice(0, query.limit);
    const last = items.at(-1);
    return {
      items: items.map((doc) => toChat(doc)),
      nextCursor: docs.length > query.limit && last ? last._id.toHexString() : null,
    };
  }

  async get(id: ObjectId): Promise<{ chat: Chat; messages: ChatMessage[] }> {
    const chat = await this.load(id);
    const messages = await this.collections.chatMessages
      .find({ chatId: id })
      .sort({ createdAt: 1, _id: 1 })
      .limit(MAX_MESSAGES)
      .toArray();
    return { chat: await this.view(chat), messages: messages.map(toChatMessage) };
  }

  /** Start a chat with the organisation's current lead, optionally about an existing project. */
  async create(input: CreateChatInput, principal: Principal): Promise<Chat> {
    const lead = await resolveLead(this.database);
    if (!lead) {
      throw conflict('no lead agent is set; choose one in the org chart first');
    }
    const projectId = input.projectId ? new ObjectId(input.projectId) : null;
    if (projectId && !(await this.collections.projects.findOne({ _id: projectId }))) {
      throw unprocessable('projectId refers to a project that does not exist');
    }
    const now = new Date();
    const doc: ChatDoc = {
      _id: new ObjectId(),
      title: input.title,
      status: 'open',
      leadAgentId: lead._id,
      projectId,
      createdBy: authorOf(principal),
      plan: null,
      approval: null,
      createdProjectId: null,
      createdIssueId: null,
      activeRunId: null,
      pendingTurn: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.collections.chats.insertOne(doc);
    return toChat(doc);
  }

  /** Rename a chat or archive it; an archived chat takes no messages and no further runs. */
  async update(id: ObjectId, input: UpdateChatInput): Promise<Chat> {
    const chat = await this.load(id);
    if (input.status === 'archived' && chat.activeRunId) {
      throw conflict('the lead is still answering; archive the chat once the reply is in');
    }
    // Archiving must not race the scheduler: a run that started meanwhile makes it fail.
    const archiving = input.status === 'archived';
    const updated = await this.collections.chats.findOneAndUpdate(
      archiving ? { _id: id, activeRunId: null } : { _id: id },
      {
        $set: {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(archiving ? { status: 'archived' as const, pendingTurn: null } : {}),
          updatedAt: new Date(),
        },
      },
      { returnDocument: 'after' },
    );
    if (!updated) {
      throw archiving
        ? conflict('the lead started answering; archive the chat once the reply is in')
        : notFound('Chat');
    }
    return this.view(updated);
  }

  /**
   * Post a board message and request a lead run for it. One turn at a time: while the lead
   * answers (or its run waits to start), the board waits for the reply.
   */
  async postMessage(
    id: ObjectId,
    input: PostChatMessageInput,
    principal: Principal,
  ): Promise<{ message: ChatMessage; chat: Chat }> {
    const chat = await this.load(id);
    if (!acceptsMessages(chat)) {
      throw conflict(
        chat.status === 'archived'
          ? 'the chat is archived'
          : 'the approved plan was carried out; start a new chat for the next plan',
      );
    }
    await assertLeadCanAnswer(this.database, chat);
    const now = new Date();
    const message: ChatMessageDoc = {
      _id: new ObjectId(),
      chatId: id,
      role: 'board',
      author: authorOf(principal),
      content: input.content,
      runId: null,
      error: null,
      createdAt: now,
    };
    const updated = await this.database.inTransaction(async (session) => {
      const next = await this.collections.chats.findOneAndUpdate(
        { _id: id, status: chat.status, activeRunId: null, pendingTurn: null },
        {
          $set: {
            pendingTurn: { reason: 'chat', requestedAt: now, notBefore: null, deferReason: null },
            lastError: null,
            updatedAt: now,
          },
        },
        { returnDocument: 'after', session },
      );
      if (!next) {
        throw conflict('the lead is still answering the previous message');
      }
      await this.collections.chatMessages.insertOne(message, { session });
      return next;
    });
    return { message: toChatMessage(message), chat: await this.view(updated) };
  }

  /**
   * Approve exactly the plan revision the board has seen: the plan is frozen, the approval is
   * recorded (and audited), and the lead is woken once to create the project and its initial
   * planning issue. The creation tools refuse before this and after they were used.
   */
  async approve(
    id: ObjectId,
    input: ApproveChatPlanInput,
    principal: Principal,
    ip: string | null,
  ): Promise<Chat> {
    const chat = await this.load(id);
    if (chat.status !== 'open') {
      throw conflict(`the chat is ${chat.status}`);
    }
    if (!chat.plan) {
      throw conflict('there is no plan to approve yet; ask the lead to write it');
    }
    if (chat.plan.revision !== input.planRevision) {
      throw conflict(
        `the plan changed: revision ${chat.plan.revision} is current, review it before approving`,
        { currentRevision: chat.plan.revision },
      );
    }
    if (chat.activeRunId || chat.pendingTurn) {
      throw conflict('the lead is still answering and may change the plan; approve afterwards');
    }
    const lead = await assertLeadCanAnswer(this.database, chat);
    const now = new Date();
    const approval = {
      userId: principal.kind === 'user' ? principal.userId : null,
      at: now,
      planRevision: input.planRevision,
    };
    const updated = await this.recordApproval(chat, approval, principal, ip, lead);
    return this.view(updated);
  }

  /** Freeze the plan, record and audit the approval and request the lead's creation run. */
  private async recordApproval(
    chat: ChatDoc,
    approval: NonNullable<ChatDoc['approval']>,
    principal: Principal,
    ip: string | null,
    lead: AgentDoc,
  ): Promise<ChatDoc> {
    const now = approval.at;
    return this.database.inTransaction(async (session) => {
      const next = await this.collections.chats.findOneAndUpdate(
        {
          _id: chat._id,
          status: 'open',
          'plan.revision': approval.planRevision,
          activeRunId: null,
          pendingTurn: null,
        },
        {
          $set: {
            status: 'approved',
            approval,
            pendingTurn: {
              reason: 'plan_approved',
              requestedAt: now,
              notBefore: null,
              deferReason: null,
            },
            lastError: null,
            updatedAt: now,
          },
        },
        { returnDocument: 'after', session },
      );
      if (!next) {
        throw conflict('the chat changed meanwhile; reload it and approve again');
      }
      await this.collections.chatMessages.insertOne(
        {
          _id: new ObjectId(),
          chatId: chat._id,
          role: 'board',
          author: authorOf(principal),
          content: approvalMessage(approval.planRevision),
          runId: null,
          error: null,
          createdAt: now,
        },
        { session },
      );
      await this.audit.write(
        {
          action: 'chat.plan_approved',
          actor: actorOf(principal),
          ip,
          details: {
            chatId: chat._id.toHexString(),
            chat: chat.title,
            planRevision: approval.planRevision,
            leadAgentId: lead._id.toHexString(),
            lead: lead.name,
          },
        },
        session,
      );
      return next;
    });
  }

  async planRevisions(id: ObjectId): Promise<{ items: ChatPlanRevision[] }> {
    await this.load(id);
    const docs = await this.collections.chatPlanRevisions
      .find({ chatId: id })
      .sort({ revision: -1 })
      .limit(200)
      .toArray();
    return { items: docs.map(toChatPlanRevision) };
  }
}
