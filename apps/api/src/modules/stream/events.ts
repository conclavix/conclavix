import type { ChangeStreamDocument, Document } from 'mongodb';
import { avatarUrl } from '../avatars/url.js';

export type StreamEventType =
  | 'run'
  | 'run_event'
  | 'issue'
  | 'comment'
  | 'agent'
  | 'agent_link'
  | 'org_layout'
  | 'org'
  | 'chat'
  | 'chat_message';

export interface StreamEvent {
  type: StreamEventType;
  data: Record<string, unknown>;
}

const WATCHED: Record<string, StreamEventType> = {
  runs: 'run',
  run_events: 'run_event',
  issues: 'issue',
  comments: 'comment',
  agents: 'agent',
  agent_links: 'agent_link',
  org_layout: 'org_layout',
  org: 'org',
  board_chats: 'chat',
  chat_messages: 'chat_message',
};

/** Collections whose deletions the board sees, as `{ id, deleted: true }`. */
const DELETABLE = new Set<StreamEventType>(['agent_link', 'org_layout']);

export const WATCHED_COLLECTIONS = Object.keys(WATCHED);

const hex = (value: unknown): unknown =>
  value && typeof value === 'object' && 'toHexString' in value
    ? (value as { toHexString(): string }).toHexString()
    : value;

const summarizeRun = (doc: Document): Record<string, unknown> => ({
  id: hex(doc['_id']),
  agentId: hex(doc['agentId']),
  kind: doc['chatId'] ? 'chat' : 'issue',
  issueId: hex(doc['issueId']) ?? null,
  chatId: hex(doc['chatId']) ?? null,
  status: doc['status'],
  reason: doc['reason'],
  costUsd: doc['costUsd'],
  error: doc['error'],
  startedAt: doc['startedAt'],
  finishedAt: doc['finishedAt'],
});

const summarizeChatMessage = (doc: Document): Record<string, unknown> => ({
  id: hex(doc['_id']),
  chatId: hex(doc['chatId']),
  role: doc['role'],
  author: doc['author'],
  content: doc['content'],
  runId: hex(doc['runId']) ?? null,
  error: doc['error'] ?? null,
  createdAt: doc['createdAt'],
});

/** The chat as the board reads it (the full plan included; the board may read it anyway). */
function summarizeChat(doc: Document): Record<string, unknown> {
  const plan = doc['plan'] as Document | null;
  const approval = doc['approval'] as Document | null;
  return {
    id: hex(doc['_id']),
    title: doc['title'],
    status: doc['status'],
    leadAgentId: hex(doc['leadAgentId']),
    projectId: hex(doc['projectId']) ?? null,
    plan: plan
      ? {
          revision: plan['revision'],
          markdown: plan['markdown'],
          runId: hex(plan['runId']) ?? null,
          updatedAt: plan['updatedAt'],
        }
      : null,
    approval: approval
      ? {
          userId: approval['userId'] ?? null,
          at: approval['at'],
          planRevision: approval['planRevision'],
        }
      : null,
    activeRunId: hex(doc['activeRunId']) ?? null,
    pendingTurn: doc['pendingTurn'] ?? null,
    lastError: doc['lastError'] ?? null,
    updatedAt: doc['updatedAt'],
  };
}

function summarize(type: StreamEventType, doc: Document): Record<string, unknown> {
  switch (type) {
    case 'run':
      return summarizeRun(doc);
    case 'run_event':
      return {
        runId: hex(doc['runId']),
        seq: doc['seq'],
        type: doc['type'],
        text: doc['text'],
        ...(doc['data'] ? { data: doc['data'] } : {}),
        at: doc['at'],
      };
    case 'issue':
      return {
        id: hex(doc['_id']),
        key: doc['key'],
        projectId: hex(doc['projectId']),
        title: doc['title'],
        status: doc['status'],
        priority: doc['priority'],
        columnId: doc['columnId'] ?? null,
        assigneeAgentId: hex(doc['assigneeAgentId']),
        checkoutRunId: hex(doc['checkoutRunId']),
      };
    case 'comment':
      return {
        id: hex(doc['_id']),
        issueId: hex(doc['issueId']),
        author: doc['author'],
        body: doc['body'],
      };
    case 'agent':
      return {
        id: hex(doc['_id']),
        name: doc['name'],
        status: doc['status'],
        avatarUrl: avatarUrl('agent', String(hex(doc['_id'])), doc['avatarEtag'] as string | null),
      };
    case 'agent_link':
      return {
        id: hex(doc['_id']),
        from: hex(doc['from']),
        to: hex(doc['to']),
        type: doc['type'],
        wakeOnReport: doc['type'] === 'reports' && doc['wakeOnReport'] === true,
      };
    case 'org_layout':
      return { agentId: hex(doc['_id']), x: doc['x'], y: doc['y'] };
    case 'org':
      return { leadAgentId: hex(doc['leadAgentId']) };
    case 'chat':
      return summarizeChat(doc);
    case 'chat_message':
      return summarizeChatMessage(doc);
  }
}

/**
 * Turn a change-stream document into the event the board sees, or null when it is not one.
 * Only the fields the UI needs are sent; tokens and instructions never leave the server.
 */
export function toStreamEvent(change: ChangeStreamDocument): StreamEvent | null {
  if (!('ns' in change) || !change.ns || !('coll' in change.ns)) {
    return null;
  }
  const type = WATCHED[change.ns.coll ?? ''];
  if (type && change.operationType === 'delete' && DELETABLE.has(type)) {
    const id = hex(change.documentKey._id);
    return {
      type,
      data: type === 'org_layout' ? { agentId: id, deleted: true } : { id, deleted: true },
    };
  }
  if (!type || !('fullDocument' in change) || !change.fullDocument) {
    return null;
  }
  return { type, data: summarize(type, change.fullDocument) };
}
