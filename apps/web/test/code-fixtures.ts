import type { BranchInfo, FileDiff, TreeEntry } from '@conclavix/core';

/** Shared data for the file browser tests: a branch, a listing, a file and diffs. */
export const SHA_A = 'a'.repeat(40);
export const SHA_B = 'b'.repeat(40);

export const file = (path: string, extra: object = {}) => ({
  ref: 'cvx/CVX-1',
  sha: SHA_B,
  path,
  size: 10,
  binary: false,
  tooLarge: false,
  content: 'x\n',
  ...extra,
});

export const branch = (name: string): BranchInfo => ({
  name,
  sha: SHA_A,
  ahead: 0,
  behind: 0,
  isDefault: name === 'main',
  issueKey: null,
  lastCommit: {
    sha: SHA_A,
    shortSha: 'aaaaaaa',
    subject: 'Start',
    authorName: 'Agent',
    committedAt: '2026-10-05T10:00:00Z',
  },
});

export const diffFile = (path: string, extra: Partial<FileDiff> = {}): FileDiff => ({
  path,
  oldPath: null,
  status: 'modified',
  binary: false,
  additions: 1,
  deletions: 1,
  patch: '@@ -1 +1 @@\n-a\n+b',
  truncated: false,
  ...extra,
});

export const ENTRIES: TreeEntry[] = [
  { name: 'src', path: 'src', type: 'tree', mode: '040000', size: null },
  { name: 'data.zip', path: 'data.zip', type: 'blob', mode: '100644', size: 2048 },
];

export function respond(url: string): unknown {
  if (url.includes('/branches')) return { items: [branch('main'), branch('cvx/CVX-1')] };
  if (url.includes('/tree')) {
    const path = new URL(url, 'http://x').searchParams.get('path') ?? '';
    return { ref: 'cvx/CVX-1', sha: SHA_B, path, entries: path === '' ? ENTRIES : [] };
  }
  if (url.includes('/file')) return file('data.zip', { binary: true, content: null, size: 2048 });
  if (url.includes('/commits/')) {
    return {
      sha: SHA_B,
      shortSha: 'bbbbbbb',
      parents: [SHA_A],
      authorName: 'Agent',
      authorEmail: 'agent@example.com',
      authoredAt: '2026-10-05T10:00:00Z',
      committerName: 'Agent',
      committedAt: '2026-10-05T10:00:00Z',
      subject: 'Change things',
      body: '',
      diff: {
        files: [
          diffFile('data.zip', { binary: true, patch: null }),
          diffFile('long.txt', { truncated: true }),
        ],
        truncated: true,
      },
    };
  }
  if (url.includes('/commits')) {
    return {
      items: [{ ...(respond('/commits/x') as object), body: undefined, diff: undefined }],
      nextSkip: null,
    };
  }
  if (url.includes('/diff')) {
    return {
      mode: url.includes('commit=') ? 'commit' : 'merge-base',
      from: 'main',
      to: 'cvx/CVX-1',
      fromSha: SHA_A,
      toSha: SHA_B,
      mergeBase: SHA_A,
      diffBase: SHA_A,
      ahead: 2,
      behind: 1,
      commits: [],
      path: null,
      diff: {
        files: [diffFile('long.txt', { patch: '@@ -1 +1 @@\n-whole\n+file' })],
        truncated: false,
      },
    };
  }
  return null;
}
