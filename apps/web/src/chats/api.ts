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
