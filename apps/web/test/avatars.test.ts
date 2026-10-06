import { describe, expect, it } from 'vitest';
import { avatarColor, avatarFileProblem, initials } from '../src/api/avatars';

describe('avatar helpers', () => {
  it('derives initials from one or two words', () => {
    expect(initials('Backend Engineer')).toBe('BE');
    expect(initials('ceo')).toBe('CE');
    expect(initials('data_pipeline-bot')).toBe('DP');
    expect(initials('  ')).toBe('?');
  });

  it('picks the same theme colour for the same key', () => {
    expect(avatarColor('agent-1')).toBe(avatarColor('agent-1'));
    const colours = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(avatarColor));
    expect(colours.size).toBeGreaterThan(1);
  });

  it('checks type and size before uploading', () => {
    const file = (type: string, size: number) => new File([new Uint8Array(size)], 'x', { type });
    expect(avatarFileProblem(file('image/png', 10))).toBeNull();
    expect(avatarFileProblem(file('image/svg+xml', 10))).toMatch(/PNG/);
    expect(avatarFileProblem(file('image/webp', 5 * 1024 * 1024 + 1))).toMatch(/5 MB/);
  });
});
