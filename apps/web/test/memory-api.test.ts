import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tokenStore } from '../src/api/client';
import { memoryApi } from '../src/api/memory';

const memory = {
  id: 'm1',
  scope: 'global',
  projectId: null,
  agentId: null,
  title: 'Title',
  body: 'Body',
  tags: ['tag'],
  author: { type: 'board' },
  revision: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};
const fields = { title: 'Title', body: 'Body', tags: [] };
const operations = [
  {
    name: 'list',
    call: () => memoryApi.list({ scope: 'global' }, ''),
    wrap: (value: unknown) => ({ items: [value] }),
  },
  { name: 'get', call: () => memoryApi.get('m1'), wrap: (value: unknown) => value },
  {
    name: 'create',
    call: () => memoryApi.create({ scope: 'global' }, fields),
    wrap: (value: unknown) => value,
  },
  { name: 'update', call: () => memoryApi.update('m1', fields), wrap: (value: unknown) => value },
];

describe('memory response validation', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    tokenStore.set('t'.repeat(32));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  for (const operation of operations) {
    it(`${operation.name} accepts board, user and agent memories`, async () => {
      for (const author of [
        { type: 'board' },
        { type: 'user', userId: 'u1' },
        { type: 'agent', agentId: 'a1' },
      ]) {
        const value = { ...memory, author };
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(operation.wrap(value))));
        expect(await operation.call()).toEqual(operation.name === 'list' ? [value] : value);
      }
    });
    it(`${operation.name} rejects malformed memories`, async () => {
      for (const invalid of [
        { ...memory, tags: 'tag' },
        { ...memory, author: { type: 'agent' } },
        { ...memory, author: { type: 'user' } },
        { ...memory, revision: '1' },
        { ...memory, scope: 'unknown' },
        { ...memory, body: null },
      ]) {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(operation.wrap(invalid))));
        await expect(operation.call()).rejects.toThrow();
      }
    });
  }
  it('rejects a malformed list envelope', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ items: null })));
    await expect(memoryApi.list({ scope: 'global' }, '')).rejects.toThrow();
  });
});
