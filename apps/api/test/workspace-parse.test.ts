import { describe, expect, it } from 'vitest';
import { parseBranches } from '../src/modules/workspace/parse.js';

describe('parseBranches', () => {
  it('orders branches by instant, not by the text of differently offset dates', () => {
    const line = (name: string, date: string) =>
      [`refs/heads/${name}`, 'a'.repeat(40), 'aaaaaaa', '1 0', 'A', date, 's'].join('\0');
    const output = [
      line('cvx/A-1', '2026-10-05T10:00:00+02:00'),
      line('cvx/A-2', '2026-10-05T09:30:00+00:00'),
      line('main', '2026-10-01T00:00:00+00:00'),
    ].join('\n');
    expect(parseBranches(output).map((b) => b.name)).toEqual(['main', 'cvx/A-2', 'cvx/A-1']);
  });
});
