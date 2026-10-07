import type { Chat, ChatMessage, ChatPlanRevision } from '@conclavix/core';
import type { ChatDoc, ChatMessageDoc, ChatPlanRevisionDoc } from '../../db.js';

/** Keys of what the approved plan created, looked up by the caller. */
export interface CreatedKeys {
  projectKey: string | null;
  issueKey: string | null;
}

export const toChat = (
  doc: ChatDoc,
  keys: CreatedKeys = { projectKey: null, issueKey: null },
): Chat => ({
  id: doc._id.toHexString(),
  title: doc.title,
  status: doc.status,
  leadAgentId: doc.leadAgentId.toHexString(),
  projectId: doc.projectId?.toHexString() ?? null,
  createdBy: doc.createdBy,
  plan: doc.plan
    ? {
        revision: doc.plan.revision,
        markdown: doc.plan.markdown,
        runId: doc.plan.runId?.toHexString() ?? null,
        updatedAt: doc.plan.updatedAt,
      }
    : null,
  approval: doc.approval,
  created: {
    projectId: doc.createdProjectId?.toHexString() ?? null,
    projectKey: keys.projectKey,
    issueId: doc.createdIssueId?.toHexString() ?? null,
    issueKey: keys.issueKey,
  },
  activeRunId: doc.activeRunId?.toHexString() ?? null,
  pendingTurn: doc.pendingTurn,
  lastError: doc.lastError,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

export const toChatMessage = (doc: ChatMessageDoc): ChatMessage => ({
  id: doc._id.toHexString(),
  chatId: doc.chatId.toHexString(),
  role: doc.role,
  author: doc.author,
  content: doc.content,
  runId: doc.runId?.toHexString() ?? null,
  error: doc.error,
  createdAt: doc.createdAt,
});

export const toChatPlanRevision = (doc: ChatPlanRevisionDoc): ChatPlanRevision => ({
  revision: doc.revision,
  markdown: doc.markdown,
  runId: doc.runId?.toHexString() ?? null,
  createdAt: doc.createdAt,
});
