import { describe, expect, it } from 'vitest';
import type { RunCode } from '../src/api/types';
import { codeLink, codeSummary } from '../src/runs/code';

const code: RunCode = {
  branch: 'cvx/COD-3',
  base: 'a'.repeat(40),
  head: 'b'.repeat(40),
  commit: 'b'.repeat(40),
  agentCommits: 1,
  files: 1,
  insertions: 12,
  deletions: 3,
  synced: true,
  error: null,
};

describe('run code summary', () => {
  it('describes the commit and the diff stats', () => {
    expect(codeSummary(code)).toEqual({
      label: `cvx/COD-3 @ ${'b'.repeat(10)}`,
      stats: 'committed · 1 file · +12 -3 · 1 commit by the agent',
    });
    expect(codeSummary({ ...code, commit: null, agentCommits: 0, files: 2 }).stats).toBe(
      'no new commit · 2 files · +12 -3',
    );
  });

  it('links to the Code tab at the commit once it is synced', () => {
    expect(codeLink(code, 'COD-3')).toEqual({
      name: 'project',
      params: { projectKey: 'COD' },
      query: { tab: 'code', branch: 'cvx/COD-3', commit: 'b'.repeat(40) },
    });
    expect(codeLink({ ...code, synced: false }, 'COD-3')).toMatchObject({
      query: { tab: 'code', branch: 'cvx/COD-3' },
    });
  });
});
