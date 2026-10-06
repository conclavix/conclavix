import { describe, expect, it } from 'vitest';
import {
  fileQuerySchema,
  issueBranchName,
  refSchema,
  repoPathSchema,
  treeQuerySchema,
} from '../src/domain/workspace.js';
import { loadConfig } from '../src/config.js';

describe('workspace schemas', () => {
  it.each(['main', 'cvx/CVX-12', 'feature/a.b_c+d', 'deadbeef'])('accepts the ref %s', (ref) => {
    expect(refSchema.safeParse(ref).success).toBe(true);
  });

  it.each(['', '-n', '--output=x', 'a..b', 'a b', 'a~1', 'a^', 'a:b', 'a@{1}', 'x'.repeat(201)])(
    'rejects the ref %j',
    (ref) => {
      expect(refSchema.safeParse(ref).success).toBe(false);
    },
  );

  it.each(['', 'README.md', 'src/a.ts', 'a b/c d.txt', ':(glob)*', 'dir/.hidden'])(
    'accepts the path %j',
    (path) => {
      expect(repoPathSchema.safeParse(path).success).toBe(true);
    },
  );

  it.each(['/etc/passwd', '../x', 'a/../b', 'a//b', './a', 'a/', '-x', 'a\nb', 'a\u0000b'])(
    'rejects the path %j',
    (path) => {
      expect(repoPathSchema.safeParse(path).success).toBe(false);
    },
  );

  it('defaults queries to main and the root, and requires a file path', () => {
    expect(treeQuerySchema.parse({})).toEqual({ ref: 'main', path: '' });
    expect(fileQuerySchema.safeParse({}).success).toBe(false);
    expect(fileQuerySchema.safeParse({ path: '' }).success).toBe(false);
    expect(treeQuerySchema.safeParse({ ref: 'main', other: 1 }).success).toBe(false);
  });

  it('names issue branches cvx/<KEY>', () => {
    expect(issueBranchName('CVX-3')).toBe('cvx/CVX-3');
  });
});

describe('WORKSPACE_ROOT', () => {
  const TOKEN = { BOARD_TOKEN: 'x'.repeat(32) };

  it('defaults to ./data/workspace and keeps explicit values', () => {
    expect(loadConfig(TOKEN).WORKSPACE_ROOT).toBe('./data/workspace');
    expect(loadConfig({ ...TOKEN, WORKSPACE_ROOT: '/srv/conclavix/code' }).WORKSPACE_ROOT).toBe(
      '/srv/conclavix/code',
    );
  });

  it('rejects empty values and control characters', () => {
    expect(() => loadConfig({ ...TOKEN, WORKSPACE_ROOT: '  ' })).toThrow(/WORKSPACE_ROOT/);
    expect(() => loadConfig({ ...TOKEN, WORKSPACE_ROOT: '/srv/a\nb' })).toThrow(/WORKSPACE_ROOT/);
  });
});
