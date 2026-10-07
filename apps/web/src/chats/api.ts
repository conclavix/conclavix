import { z } from 'zod';
import { api } from '../api/client';
import type { Page } from '../api/types';

export type ChatStatus = 'open' | 'approved' | 'archived';

export type ChatAuthor =
  | { type: 'board' }
  | { type: 'user'; userId: string }
  | { type: 'system' }
  | { type: 'agent'; agentId: string };

export interface ChatTurn {
  reason: 'chat' | 'plan_approved';
  requestedAt: string;
  notBefore: string | null;
  deferReason: 'daily_cost_limit' | null;
}

export interface ChatPlan {
  revision: number;
  markdown: string;
  runId: string | null;
  updatedAt: string;
}

export interface Chat {
  id: string;
  title: string;
  status: ChatStatus;
  leadAgentId: string;
  projectId: string | null;
  createdBy?: ChatAuthor;
  plan: ChatPlan | null;
  approval: { userId: string | null; at: string; planRevision: number } | null;
  /** Missing on stream updates; the chat read fills it in. */
  created?: {
    projectId: string | null;
    projectKey: string | null;
    issueId: string | null;
    issueKey: string | null;
  };
  activeRunId: string | null;
  pendingTurn: ChatTurn | null;
  lastError: string | null;
  createdAt?: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  chatId: string;
  role: 'board' | 'agent';
  author: ChatAuthor;
  content: string;
  runId: string | null;
  error: string | null;
  createdAt: string;
}

export interface ChatPlanRevision {
  revision: number;
  markdown: string;
  runId: string | null;
  createdAt: string;
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

export const chatApi = {
  list: () => api<Page<Chat>>('/chats?limit=100'),
  get: (id: string) => api<{ chat: Chat; messages: ChatMessage[] }>(`/chats/${id}`),
  create: (input: { title: string; projectId: string | null }) =>
    api<Chat>('/chats', { method: 'POST', ...json(input) }),
  archive: (id: string) =>
    api<Chat>(`/chats/${id}`, { method: 'PATCH', ...json({ status: 'archived' }) }),
  post: (id: string, content: string) =>
    api<{ message: ChatMessage; chat: Chat }>(`/chats/${id}/messages`, {
      method: 'POST',
      ...json({ content }),
    }),
  approve: (id: string, planRevision: number) =>
    api<Chat>(`/chats/${id}/approve`, { method: 'POST', ...json({ planRevision }) }),
  revisions: (id: string) => api<Page<ChatPlanRevision>>(`/chats/${id}/plan/revisions`),
};

const turnSchema = z.object({
  reason: z.enum(['chat', 'plan_approved']),
  requestedAt: z.string(),
  notBefore: z.string().nullable(),
  deferReason: z.literal('daily_cost_limit').nullable(),
});

/** A chat as the event stream sends it (no created project and issue; the chat read has them). */
const chatEventSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['open', 'approved', 'archived']),
  leadAgentId: z.string(),
  projectId: z.string().nullable(),
  plan: z
    .object({
      revision: z.number(),
      markdown: z.string(),
      runId: z.string().nullable(),
      updatedAt: z.string(),
    })
    .nullable(),
  approval: z
    .object({ userId: z.string().nullable(), at: z.string(), planRevision: z.number() })
    .nullable(),
  activeRunId: z.string().nullable(),
  pendingTurn: turnSchema.nullable(),
  lastError: z.string().nullable(),
  updatedAt: z.string(),
});

const authorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('board') }),
  z.object({ type: z.literal('user'), userId: z.string() }),
  z.object({ type: z.literal('system') }),
  z.object({ type: z.literal('agent'), agentId: z.string() }),
]);

const chatMessageEventSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  role: z.enum(['board', 'agent']),
  author: authorSchema,
  content: z.string(),
  runId: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
});

/** Parse a `chat` stream event; null for anything that is not a well-formed chat. */
export const parseChatEvent = (data: unknown): Chat | null =>
  chatEventSchema.safeParse(data).data ?? null;

/** Parse a `chat_message` stream event; null for anything that is not a well-formed message. */
export const parseChatMessageEvent = (data: unknown): ChatMessage | null =>
  chatMessageEventSchema.safeParse(data).data ?? null;
