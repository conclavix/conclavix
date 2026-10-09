import { z } from 'zod';
import type { Author } from './collaboration.js';
import { idSchema } from './ids.js';

/**
 * A board chat with the lead agent: the board and the lead discuss a plan, the lead keeps the plan
 * document, and once the board approves a plan revision the lead creates the project and its
 * initial planning issue (once). open: discussing; approved: plan frozen, creation runs or ran;
 * archived: closed without (further) action.
 */
export const chatStatusSchema = z.enum(['open', 'approved', 'archived']);

/** Who wrote a chat message: the board side (a user or the board token) or the lead agent. */
export const chatRoleSchema = z.enum(['board', 'agent']);

/** Why a chat run was requested: a board message, or the approval of the plan. */
export const chatTurnReasonSchema = z.enum(['chat', 'plan_approved']);

export const CHAT_LIMITS = {
  title: 200,
  message: 20_000,
  plan: 100_000,
  /** Messages the lead sees as history in a chat run, newest kept. */
  historyMessages: 40,
  /** Characters of history in a chat run; older messages are dropped first. */
  historyChars: 60_000,
  /** Characters of a single message in the run history; longer ones are cut. */
  historyMessageChars: 8_000,
} as const;

export const createChatSchema = z.strictObject({
  title: z.string().trim().min(1).max(CHAT_LIMITS.title),
  /** An existing project the plan is about; its code and memory become readable in the chat. */
  projectId: idSchema.nullable().default(null),
});

export const updateChatSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(CHAT_LIMITS.title),
    status: z.literal('archived'),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');

export const postChatMessageSchema = z.strictObject({
  content: z.string().trim().min(1).max(CHAT_LIMITS.message),
});

/** The board approves exactly the plan revision it has seen. */
export const approveChatPlanSchema = z.strictObject({
  planRevision: z.int().min(1),
});

export const listChatsQuerySchema = z.strictObject({
  /** One or more statuses, comma-separated (e.g. `open,approved`). */
  status: z
    .string()
    .transform((value) => value.split(','))
    .pipe(z.array(chatStatusSchema))
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: idSchema.optional(),
});

export type ChatStatus = z.infer<typeof chatStatusSchema>;
export type ChatRole = z.infer<typeof chatRoleSchema>;
export type ChatTurnReason = z.infer<typeof chatTurnReasonSchema>;
export type CreateChatInput = z.infer<typeof createChatSchema>;
export type UpdateChatInput = z.infer<typeof updateChatSchema>;
export type PostChatMessageInput = z.infer<typeof postChatMessageSchema>;
export type ApproveChatPlanInput = z.infer<typeof approveChatPlanSchema>;
export type ListChatsQuery = z.infer<typeof listChatsQuerySchema>;

/** A requested lead run for the chat that the scheduler has not started yet. */
export interface ChatTurn {
  reason: ChatTurnReason;
  requestedAt: Date;
  /** Set while the turn waits for the lead's daily cost limit to reset. */
  notBefore: Date | null;
  deferReason: 'daily_cost_limit' | null;
}

export interface ChatPlan {
  revision: number;
  markdown: string;
  /** The run that wrote this revision. */
  runId: string | null;
  updatedAt: Date;
}

export interface ChatApproval {
  /** The approving user; null for the legacy board token. */
  userId: string | null;
  at: Date;
  planRevision: number;
}

export interface ChatCreated {
  projectId: string | null;
  projectKey: string | null;
  issueId: string | null;
  issueKey: string | null;
}

export interface Chat {
  id: string;
  title: string;
  status: ChatStatus;
  leadAgentId: string;
  projectId: string | null;
  createdBy: Author;
  plan: ChatPlan | null;
  approval: ChatApproval | null;
  created: ChatCreated;
  /** The lead's run answering right now, if any. */
  activeRunId: string | null;
  pendingTurn: ChatTurn | null;
  /** Why the last requested turn did not start (e.g. the lead was paused meanwhile). */
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatMessage {
  id: string;
  chatId: string;
  role: ChatRole;
  author: Author;
  content: string;
  /** For agent messages: the run that wrote the reply. */
  runId: string | null;
  /** For agent messages of failed runs: the (redacted) run error. */
  error: string | null;
  createdAt: Date;
}

export interface ChatPlanRevision {
  revision: number;
  markdown: string;
  runId: string | null;
  createdAt: Date;
}
