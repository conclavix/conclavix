import type { ObjectId } from 'mongodb';
import type { Author, ChatRole, ChatStatus, ChatTurnReason } from '@conclavix/core';
import type { RunDoc } from '../db.js';

/** A run bound to an issue: every run the scheduler creates from a wake. */
export type IssueRunDoc = RunDoc & { issueId: ObjectId };

/** A run answering a board chat. */
export type ChatRunDoc = RunDoc & { issueId: null; chatId: ObjectId };

export const isChatRun = (run: RunDoc): run is ChatRunDoc =>
  run.chatId !== undefined && run.chatId !== null;

export interface ChatTurnDoc {
  reason: ChatTurnReason;
  requestedAt: Date;
  notBefore: Date | null;
  deferReason: 'daily_cost_limit' | null;
}

export interface ChatDoc {
  _id: ObjectId;
  title: string;
  status: ChatStatus;
  leadAgentId: ObjectId;
  /** An existing project the chat is about (code and memory readable in its runs). */
  projectId: ObjectId | null;
  createdBy: Author;
  plan: { revision: number; markdown: string; runId: ObjectId | null; updatedAt: Date } | null;
  approval: { userId: string | null; at: Date; planRevision: number } | null;
  createdProjectId: ObjectId | null;
  createdIssueId: ObjectId | null;
  activeRunId: ObjectId | null;
  pendingTurn: ChatTurnDoc | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatMessageDoc {
  _id: ObjectId;
  chatId: ObjectId;
  role: ChatRole;
  author: Author;
  content: string;
  runId: ObjectId | null;
  error: string | null;
  createdAt: Date;
}

export interface ChatPlanRevisionDoc {
  _id: ObjectId;
  chatId: ObjectId;
  revision: number;
  markdown: string;
  runId: ObjectId | null;
  createdAt: Date;
}
