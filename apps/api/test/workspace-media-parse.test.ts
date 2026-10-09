import { describe, expect, it } from 'vitest';
import { mediaQuerySchema } from '@conclavix/core';
import { filterMedia, parseBlobWrites, parseScanRefs } from '../src/modules/workspace/media.js';
import { parseByteRange } from '../src/modules/workspace/routes.js';

describe('media parsing', () => {
  it('reads main first and only issue branches', () => {
    const sha = 'a'.repeat(40);
    const tree = 'b'.repeat(40);
    const refs = parseScanRefs(
      [
        `refs/heads/cvx/ABC-2\0${sha}\0${tree}`,
        `refs/heads/cvx/not a key\0${sha}\0${tree}`,
        `refs/heads/main\0${sha}\0${tree}`,
        `refs/heads/feature\0${sha}\0${tree}`,
        `refs/heads/cvx/ABC-1\0bad\0${tree}`,
        '',
      ].join('\n'),
    );
    expect(refs.map((ref) => ref.branch)).toEqual(['main', 'cvx/ABC-2']);
  });

  it('reads the blobs each commit wrote and skips deletions', () => {
    const c1 = '1'.repeat(40);
    const c2 = '2'.repeat(40);
    const zero = '0'.repeat(40);
    const blob = 'b'.repeat(40);
    const other = 'c'.repeat(40);
    const output =
      `\u001e${c2}\u001fAgent\u001f2026-10-02T00:00:00Z\0\n` +
      `:100644 100644 ${blob} ${other} M\0a.png\0` +
      `:100644 000000 ${blob} ${zero} D\0gone.png\0` +
      `\u001e${c1}\u001fAgent\u001f2026-10-01T00:00:00Z\0\n` +
      `:000000 100644 ${zero} ${blob} A\0a.png\0`;
    expect(parseBlobWrites(output)).toEqual([
      {
        sha: c2,
        authorName: 'Agent',
        committedAt: '2026-10-02T00:00:00Z',
        oid: other,
        path: 'a.png',
      },
      {
        sha: c1,
        authorName: 'Agent',
        committedAt: '2026-10-01T00:00:00Z',
        oid: blob,
        path: 'a.png',
      },
    ]);
  });

  it('sorts files without a known commit last', () => {
    const base = {
      oid: 'x',
      name: 'a',
      kind: 'image' as const,
      contentType: 'image/png',
      size: 1,
      locations: [],
      ref: 'r',
    };
    const items = [
      { ...base, path: 'b', commit: null },
      {
        ...base,
        path: 'a',
        commit: { sha: 's', authorName: 'A', committedAt: '2026-01-01T00:00:00Z' },
      },
      {
        ...base,
        path: 'c',
        commit: { sha: 's', authorName: 'A', committedAt: '2026-02-01T00:00:00Z' },
      },
    ];
    const newest = filterMedia(items, mediaQuerySchema.parse({}));
    expect(newest.map((item) => item.path)).toEqual(['c', 'a', 'b']);
    const oldest = filterMedia(items, mediaQuerySchema.parse({ sort: 'oldest' }));
    expect(oldest.map((item) => item.path)).toEqual(['a', 'c', 'b']);
  });

  it('parses single byte ranges', () => {
    expect(parseByteRange(undefined, 10)).toBeNull();
    expect(parseByteRange('bytes=0-', 10)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange('bytes=2-4', 10)).toEqual({ start: 2, end: 4 });
    expect(parseByteRange('bytes=5-100', 10)).toEqual({ start: 5, end: 9 });
    expect(parseByteRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseByteRange('bytes=-30', 10)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange('bytes=0-1,4-5', 10)).toBeNull();
    expect(parseByteRange('items=0-1', 10)).toBeNull();
    expect(parseByteRange('bytes=-', 10)).toBeNull();
    expect(parseByteRange('bytes=10-', 10)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=4-2', 10)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=-0', 10)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=0-', 0)).toBe('unsatisfiable');
  });
});
