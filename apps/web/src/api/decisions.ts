import { api } from './client';

export type DecisionStatus = 'open' | 'answered' | 'dismissed' | 'withdrawn' | 'superseded';

export interface DecisionAuthor {
  type: string;
  userId?: string;
  agentId?: string;
}

/** A question an agent put to the board (GET /api/decisions). */
export interface Decision {
  id: string;
  status: DecisionStatus;
  question: string;
  options: string[];
  askedAt: string;
  askedBy: { agentId: string; name: string | null };
  issue: { id: string; key: string; title: string; status: string };
  project: { id: string; key: string; name: string } | null;
  decidedAt: string | null;
  decidedBy: DecisionAuthor | null;
  answer: string | null;
}

export interface DecisionAnswer {
  option?: string;
  body?: string;
}

/** An answer as one line of plain text for lists: Markdown bold markers and line breaks removed. */
export const plainAnswer = (answer: string | null): string =>
  answer === null ? 'no answer' : answer.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();

/** Roles holding the `work` capability, which answering and dismissing need. */
const DECIDER_ROLES: ReadonlySet<string> = new Set(['owner', 'admin', 'member']);

export const canDecide = (role: string | null | undefined): boolean =>
  !!role && DECIDER_ROLES.has(role);

export const decisionsApi = {
  list: (status: 'open' | 'decided', limit = 100) =>
    api<{ items: Decision[]; total: number }>(`/decisions?status=${status}&limit=${limit}`),
  count: () => api<{ open: number }>('/decisions/count'),
  answer: (id: string, input: DecisionAnswer) =>
    api<Decision>(`/decisions/${id}/answer`, { method: 'POST', body: JSON.stringify(input) }),
  dismiss: (id: string, reason?: string) =>
    api<Decision>(`/decisions/${id}/dismiss`, {
      method: 'POST',
      body: JSON.stringify(reason ? { reason } : {}),
    }),
};
