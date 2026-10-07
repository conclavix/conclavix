import { isAdminRole } from '../admin/gating';
import type { Chat, ChatMessage } from './api';

/** Owners and admins talk to the lead and approve its plans; everyone else reads along. */
export const canChat = (role: string | null | undefined): boolean => isAdminRole(role);

export const CHAT_STATUS_COLORS: Record<string, string> = {
  open: 'info',
  approved: 'success',
  archived: 'grey',
};

/** True while the lead answers or its run waits to start; the board waits for the reply. */
export const isBusy = (chat: Pick<Chat, 'activeRunId' | 'pendingTurn'>): boolean =>
  chat.activeRunId !== null || chat.pendingTurn !== null;

/** Whether the board may still write: mirrors the server (open, or approved until the issue exists). */
export const acceptsMessages = (chat: Pick<Chat, 'status' | 'created'>): boolean =>
  chat.status === 'open' || (chat.status === 'approved' && !chat.created?.issueId);

/** What the lead is doing right now, for the line above the input; null when idle. */
export function turnStatus(
  chat: Pick<Chat, 'activeRunId' | 'pendingTurn'>,
  leadName: string,
): string | null {
  if (chat.activeRunId) return `${leadName} is answering…`;
  const turn = chat.pendingTurn;
  if (!turn) return null;
  if (turn.deferReason === 'daily_cost_limit' && turn.notBefore) {
    return `${leadName} reached its daily cost limit; the reply starts ${new Date(turn.notBefore).toLocaleString()}`;
  }
  return turn.reason === 'plan_approved'
    ? `${leadName} will create the project and the planning issue shortly…`
    : `${leadName} will answer shortly…`;
}

/** Why "Approve plan" is unavailable, or null when the board may approve now. */
export function approveBlock(
  chat: Pick<Chat, 'status' | 'plan' | 'activeRunId' | 'pendingTurn'>,
  role: string | null | undefined,
): string | null {
  if (!canChat(role)) return 'Only admins and owners approve plans.';
  if (chat.status !== 'open') return `The chat is ${chat.status}.`;
  if (!chat.plan) return 'The lead has not written a plan yet.';
  if (isBusy(chat)) return 'Wait for the reply: the lead may still change the plan.';
  return null;
}

/**
 * Add or replace a message, keeping the list in creation order. The API and the runner both write
 * messages, so ids alone do not sort by time; the id only breaks ties.
 */
export function mergeMessage(
  messages: readonly ChatMessage[],
  message: ChatMessage,
): ChatMessage[] {
  const others = messages.filter((item) => item.id !== message.id);
  const key = (item: ChatMessage): string => `${item.createdAt}|${item.id}`;
  return [...others, message].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}
