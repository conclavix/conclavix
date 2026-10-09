import { describe, expect, it } from 'vitest';
import type { Chat, ChatMessage } from '../src/chats/api';
import {
  acceptsMessages,
  approveBlock,
  canChat,
  isBusy,
  mergeMessage,
  turnStatus,
} from '../src/chats/logic';

const chat = (overrides: Partial<Chat> = {}): Chat => ({
  id: 'c1',
  title: 'Plan',
  status: 'open',
  leadAgentId: 'a1',
  projectId: null,
  plan: { revision: 2, markdown: '# Plan', runId: null, updatedAt: '2026-01-01T00:00:00Z' },
  approval: null,
  activeRunId: null,
  pendingTurn: null,
  lastError: null,
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

const message = (id: string): ChatMessage => ({
  id,
  chatId: 'c1',
  role: 'board',
  author: { type: 'board' },
  content: id,
  runId: null,
  error: null,
  createdAt: '2026-01-01T00:00:00Z',
});

describe('chat logic', () => {
  it('lets only admins and owners chat', () => {
    expect(['owner', 'admin', 'member', 'viewer', undefined].map(canChat)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it('explains why a plan cannot be approved yet', () => {
    expect(approveBlock(chat(), 'admin')).toBeNull();
    expect(approveBlock(chat(), 'viewer')).toMatch(/admins and owners/);
    expect(approveBlock(chat({ plan: null }), 'owner')).toMatch(/not written a plan/);
    expect(approveBlock(chat({ activeRunId: 'r1' }), 'owner')).toMatch(/Wait for the reply/);
    expect(approveBlock(chat({ status: 'approved' }), 'owner')).toMatch(/approved/);
  });

  it('describes what the lead is doing', () => {
    expect(turnStatus(chat(), 'Mr. Green')).toBeNull();
    expect(turnStatus(chat({ activeRunId: 'r1' }), 'Mr. Green')).toBe('Mr. Green is answering…');
    const pending = {
      reason: 'chat' as const,
      requestedAt: '2026-01-01T00:00:00Z',
      notBefore: null,
      deferReason: null,
    };
    expect(turnStatus(chat({ pendingTurn: pending }), 'Mr. Green')).toMatch(/answer shortly/);
    expect(
      turnStatus(
        chat({
          pendingTurn: {
            ...pending,
            notBefore: '2026-01-02T00:00:00Z',
            deferReason: 'daily_cost_limit',
          },
        }),
        'Mr. Green',
      ),
    ).toMatch(/daily cost limit/);
    expect(isBusy(chat({ pendingTurn: pending }))).toBe(true);
  });

  it('accepts messages until the approved plan created its issue', () => {
    expect(acceptsMessages(chat())).toBe(true);
    expect(acceptsMessages(chat({ status: 'archived' }))).toBe(false);
    const created = { projectId: 'p', projectKey: 'P', issueId: null, issueKey: null };
    expect(acceptsMessages(chat({ status: 'approved', created }))).toBe(true);
    expect(
      acceptsMessages(chat({ status: 'approved', created: { ...created, issueId: 'i' } })),
    ).toBe(false);
  });

  it('merges messages in order without duplicates', () => {
    const merged = mergeMessage([message('b'), message('a')], message('c'));
    expect(mergeMessage(merged, message('b')).map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });
});
