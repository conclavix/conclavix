import { describe, expect, it } from 'vitest';
import { listQuery, type Memory } from '../src/api/memory';
import { bucketFor, changedFields, fieldsProblem, groupHits, parseTags } from '../src/memory/logic';
import { renderMarkdown } from '../src/memory/markdown';

const memory = (id: string, body: string, extra: Partial<Memory> = {}): Memory => ({
  id,
  scope: 'global',
  projectId: null,
  agentId: null,
  title: `title ${id}`,
  body,
  tags: [],
  author: { type: 'board' },
  revision: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...extra,
});

describe('memory buckets and queries', () => {
  it('needs an owner for project and agent buckets', () => {
    expect(bucketFor('global', 'p1', 'a1')).toEqual({ scope: 'global' });
    expect(bucketFor('project')).toBeNull();
    expect(bucketFor('project', 'p1', 'a1')).toEqual({ scope: 'project', projectId: 'p1' });
    expect(bucketFor('agent', 'p1', null)).toBeNull();
    expect(bucketFor('agent', null, 'a1')).toEqual({ scope: 'agent', agentId: 'a1' });
  });

  it('builds the list query with only the owner of the bucket and a trimmed search', () => {
    expect(listQuery({ scope: 'global' }, '  ')).toBe('scope=global&limit=50');
    expect(listQuery({ scope: 'agent', agentId: 'a1' }, ' redis cache ')).toBe(
      'scope=agent&limit=50&agentId=a1&q=redis+cache',
    );
  });
});

describe('memory editing helpers', () => {
  it('parses tags without empties or case-insensitive duplicates', () => {
    expect(parseTags(' redis, ,Ops,redis , ops,deploy')).toEqual(['redis', 'Ops', 'deploy']);
    expect(parseTags('')).toEqual([]);
  });

  it('reports the first rule the API would reject', () => {
    const ok = { title: 'T', body: 'B', tags: [] };
    expect(fieldsProblem(ok)).toBeNull();
    expect(fieldsProblem({ ...ok, title: '  ' })).toBe('Title is required');
    expect(fieldsProblem({ ...ok, body: 'x'.repeat(20001) })).toMatch(/at most 20000/);
    expect(fieldsProblem({ ...ok, tags: Array.from({ length: 21 }, (_, i) => `t${i}`) })).toBe(
      'At most 20 tags',
    );
    expect(fieldsProblem({ ...ok, tags: ['x'.repeat(41)] })).toMatch(/longer than 40/);
  });

  it('patches only the fields that changed', () => {
    const before = memory('m1', 'body', { title: ' Title ', tags: ['a'] });
    expect(changedFields(before, { title: ' Title ', body: 'body\n', tags: ['a'] })).toEqual({});
    expect(changedFields(before, { title: 'New', body: 'body', tags: ['a', 'b'] })).toEqual({
      title: 'New',
      tags: ['a', 'b'],
    });
  });
});

describe('search hits', () => {
  it('groups facts of the same memory in rank order and drops repeated excerpts', () => {
    const hits = groupHits([
      memory('m2', 'fact one'),
      memory('m1', 'other'),
      memory('m2', 'fact two'),
      memory('m2', 'fact one'),
    ]);
    expect(hits.map((hit) => hit.memory.id)).toEqual(['m2', 'm1']);
    expect(hits[0]?.excerpts).toEqual(['fact one', 'fact two']);
  });
});

describe('markdown', () => {
  it('renders markdown and escapes raw HTML', () => {
    const html = renderMarkdown('# Head\n\n**bold** <script>alert(1)</script>');
    expect(html).toContain('<h1>Head</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it.each([
    '![tracking](https://example.com/pixel.png)',
    '![tracking](//example.com/pixel.png)',
    '![tracking](/pixel.png)',
    '![tracking][pixel]\n\n[pixel]: https://example.com/pixel.png',
    '[![tracking](https://example.com/pixel.png)](https://example.com)',
    '<img src="https://example.com/pixel.png" alt="tracking">',
  ])('does not embed images from %s', (source) => {
    const document = new DOMParser().parseFromString(renderMarkdown(source), 'text/html');
    expect(document.querySelector('img')).toBeNull();
    expect(document.body.textContent).toContain('tracking');
  });

  it('drops javascript links and opens others in a new tab', () => {
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('href');
    const html = renderMarkdown('[docs](https://example.com)');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
