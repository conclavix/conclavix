import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/client';
import type { DirectoryDetail, SkillSource } from '../src/api/skill-sources';
import {
  directoryErrorText,
  importState,
  quotaText,
  safeImageUrl,
  sourcePayload,
  suggestSkillName,
  type SourceDraft,
} from '../src/skills/directory';

const draft = (patch: Partial<SourceDraft> = {}): SourceDraft => ({
  name: ' Dir ',
  provider: 'skillsdirectory',
  baseUrl: '',
  apiKey: '',
  removeKey: false,
  enabled: true,
  ...patch,
});
const existing = { id: 's1', hasApiKey: true } as SkillSource;

describe('skill directory helpers', () => {
  it('builds create and update bodies with a write-only key', () => {
    expect(sourcePayload(draft({ apiKey: 'k' }), null)).toEqual({
      name: 'Dir',
      enabled: true,
      provider: 'skillsdirectory',
      apiKey: 'k',
    });
    expect(sourcePayload(draft(), existing)).toEqual({ name: 'Dir', enabled: true, baseUrl: null });
    expect(sourcePayload(draft({ apiKey: 'new' }), existing).apiKey).toBe('new');
    expect(sourcePayload(draft({ apiKey: 'new', removeKey: true }), existing).apiKey).toBeNull();
    expect(sourcePayload(draft({ baseUrl: ' https://x.test/api ' }), existing).baseUrl).toBe(
      'https://x.test/api',
    );
  });

  it('describes the remaining budget', () => {
    expect(quotaText(null)).toBeNull();
    expect(quotaText({ remaining: null, limit: null, tier: 'free', resetAt: null })).toBeNull();
    expect(quotaText({ remaining: 87, limit: 100, tier: 'free', resetAt: null })).toBe(
      '87 of 100 requests left today (free plan)',
    );
    expect(quotaText({ remaining: 1, limit: null, tier: null, resetAt: null })).toBe(
      '1 request left today',
    );
  });

  it('allows import only with content', () => {
    const base = { skill: { webUrl: 'https://d.test/skills/x' } } as DirectoryDetail;
    expect(importState(null).allowed).toBe(false);
    expect(
      importState({
        ...base,
        content: { available: false, reason: 'tier', message: 'paid plan only' },
      }),
    ).toEqual({ allowed: false, reason: 'paid plan only', url: 'https://d.test/skills/x' });
    expect(
      importState({ ...base, content: { available: true, content: 'x', contentHash: 'h' } })
        .allowed,
    ).toBe(true);
  });

  it('suggests valid names and shows only https images', () => {
    expect(suggestSkillName('My_Skill--v2!')).toBe('my-skill-v2');
    expect(suggestSkillName(`${'a'.repeat(63)}-b`)).toBe('a'.repeat(63));
    expect(safeImageUrl('https://x.test/a.png')).toBe('https://x.test/a.png');
    expect(safeImageUrl('http://x.test/a.png')).toBeNull();
    expect(safeImageUrl('javascript:alert(1)')).toBeNull();
  });

  it('explains directory errors including the rate-limit reset', () => {
    expect(directoryErrorText(new ApiError('x', 502, 'directory_auth_failed'))).toContain(
      'rejected the API key',
    );
    const limited = directoryErrorText(
      new ApiError('x', 429, 'directory_rate_limited', { resetAt: '2026-10-06T00:00:00.000Z' }),
    );
    expect(limited).toContain('used up');
    expect(limited).toContain('resets');
    expect(directoryErrorText(new ApiError('Other', 409, 'conflict'))).toBe('Other');
  });
});
