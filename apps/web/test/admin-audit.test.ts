import { describe, expect, it } from 'vitest';
import { actorLabel, auditQuery, auditSummary } from '../src/admin/audit';

describe('audit view helpers', () => {
  it('builds the query with an inclusive end day', () => {
    const query = new URLSearchParams(
      auditQuery(
        {
          actions: ['user.banned', 'user.unbanned'],
          actor: 'board',
          from: '2026-10-01',
          to: '2026-10-02',
        },
        50,
        'abc',
      ),
    );
    expect(query.get('action')).toBe('user.banned,user.unbanned');
    expect(query.get('actor')).toBe('board');
    expect(query.get('before')).toBe('abc');
    expect(new Date(query.get('to') ?? '').getTime()).toBe(
      new Date('2026-10-03T00:00:00').getTime(),
    );
    expect(new Date(query.get('from') ?? '').getTime()).toBe(
      new Date('2026-10-01T00:00:00').getTime(),
    );
  });

  it('labels actors', () => {
    expect(actorLabel({ type: 'board' }, {})).toBe('board token');
    expect(actorLabel({ type: 'agent', agentId: 'a1', name: 'Integrator' }, {})).toBe(
      'agent Integrator',
    );
    expect(actorLabel({ type: 'user', userId: 'u1' }, { u1: 'Ada' })).toBe('Ada');
    expect(actorLabel({ type: 'user', userId: '0123456789ab' }, {})).toMatch(/deleted user/);
    expect(actorLabel(null, {})).toBe('anonymous');
    // Without a loaded user list an unknown id is not claimed to be deleted.
    expect(actorLabel({ type: 'user', userId: '0123456789ab' }, {}, false)).toBe('user 6789ab');
  });

  it('summarises details and never prints credential-like fields', () => {
    expect(
      auditSummary({ action: 'user.role_changed', details: { from: 'member', to: 'admin' } }),
    ).toBe('member → admin');
    expect(
      auditSummary({ action: 'settings.changed', details: { groups: ['smtp', 'models'] } }),
    ).toBe('groups: smtp, models');
    const summary = auditSummary({
      action: 'user.created',
      details: {
        delivery: 'temporary',
        temporaryPassword: 'leak-1',
        pass: 'leak-2',
        token: 'leak-3',
        nested: { secret: 'leak-4' },
      },
    });
    expect(summary).toBe('delivery: temporary');
  });
});
