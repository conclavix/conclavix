import { describe, expect, it } from 'vitest';
import {
  archiveQuerySchema,
  diffQuerySchema,
  downloadContentType,
  rawQuerySchema,
} from '../src/domain/browse.js';
import { loadConfig } from '../src/config.js';

describe('file browser schemas', () => {
  it.each([
    ['a.png', 'image/png'],
    ['clip.webm', 'video/webm'],
    ['doc.PDF', 'application/pdf'],
    ['icon.svg', 'application/octet-stream'],
    ['page.html', 'application/octet-stream'],
    ['app.js', 'application/octet-stream'],
    ['a.constructor', 'application/octet-stream'],
    ['Makefile', 'application/octet-stream'],
  ])('downloads %s as %s', (path, type) => {
    expect(downloadContentType(path)).toBe(type);
  });

  it('parses the download flag and folder archives', () => {
    expect(rawQuerySchema.parse({ path: 'a', download: '1' })).toEqual({
      ref: 'main',
      path: 'a',
      download: true,
    });
    expect(rawQuerySchema.safeParse({ path: 'a', other: '1' }).success).toBe(false);
    expect(archiveQuerySchema.parse({})).toEqual({ ref: 'main', path: '' });
    expect(archiveQuerySchema.safeParse({ path: '../x' }).success).toBe(false);
  });

  it('takes either a commit or a target ref for a diff', () => {
    expect(diffQuerySchema.parse({ to: 'cvx/A-1' })).toEqual({ to: 'cvx/A-1', mode: 'merge-base' });
    expect(diffQuerySchema.parse({ commit: 'abcdef0', path: 'a.ts' }).path).toBe('a.ts');
    expect(diffQuerySchema.safeParse({}).success).toBe(false);
    expect(diffQuerySchema.safeParse({ commit: 'abcdef0', to: 'main' }).success).toBe(false);
    expect(diffQuerySchema.safeParse({ commit: 'abcdef0', from: 'main' }).success).toBe(false);
    expect(diffQuerySchema.safeParse({ to: 'main', path: '' }).success).toBe(false);
  });

  it('configures the download limit in MiB', () => {
    expect(loadConfig({}).CODE_DOWNLOAD_MAX_MB).toBe(100);
    expect(loadConfig({ CODE_DOWNLOAD_MAX_MB: '5' }).CODE_DOWNLOAD_MAX_MB).toBe(5);
    expect(() => loadConfig({ CODE_DOWNLOAD_MAX_MB: '0' })).toThrow();
  });
});
