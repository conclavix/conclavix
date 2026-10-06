import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tokenStore } from '../src/api/client';
import { SKILL_NAME_PATTERN, useSkillsStore } from '../src/stores/skills';

const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('skills store', () => {
  let calls: { url: string; method: string; body?: unknown }[];

  beforeEach(() => {
    setActivePinia(createPinia());
    tokenStore.set('t'.repeat(32));
    calls = [];
    const summary = { id: 's1', name: 'review', description: 'd', fileCount: 0, updatedAt: '' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? 'GET';
        calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
        if (method === 'DELETE') return json(null, 204);
        if (url === '/api/skills' && method === 'GET') return json({ items: [summary] });
        return json(
          { ...summary, body: '', files: [], createdAt: '' },
          method === 'POST' ? 201 : 200,
        );
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStore.clear();
  });

  it('creates with POST, updates with PATCH without touching files, and reloads the list', async () => {
    const store = useSkillsStore();
    const draft = { name: 'review', description: 'd', body: '# x' };
    await store.save(draft);
    await store.save(draft, 's1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST /api/skills',
      'GET /api/skills',
      'PATCH /api/skills/s1',
      'GET /api/skills',
    ]);
    expect(calls[2]?.body).toEqual(draft);
    expect(store.items.map((item) => item.name)).toEqual(['review']);
  });

  it('deletes and reloads', async () => {
    const store = useSkillsStore();
    await store.remove('s1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'DELETE /api/skills/s1',
      'GET /api/skills',
    ]);
  });

  it.each(['create', 'update', 'delete'])(
    'preserves successful %s when refresh fails',
    async (operation) => {
      const store = useSkillsStore();
      await store.load();
      const original = vi.mocked(fetch).getMockImplementation();
      if (!original) throw new Error('Missing fetch mock');
      vi.mocked(fetch).mockImplementation((url, init) =>
        url === '/api/skills' && !init?.method
          ? Promise.resolve(json({ message: 'unavailable' }, 503))
          : original(url, init),
      );
      if (operation === 'delete') {
        await expect(store.remove('s1')).resolves.toBeUndefined();
        expect(store.items).toEqual([]);
      } else {
        await expect(
          store.save(
            { name: 'review', description: 'd', body: '' },
            operation === 'update' ? 's1' : undefined,
          ),
        ).resolves.toMatchObject({ id: 's1' });
        expect(store.items).toHaveLength(1);
      }
      expect(store.refreshError).toContain('Could not refresh');
    },
  );

  it.each(['load', 'get', 'create', 'update'])(
    'rejects malformed %s responses before use',
    async (operation) => {
      const store = useSkillsStore();
      vi.mocked(fetch).mockResolvedValue(
        json(
          operation === 'load'
            ? {
                items: [
                  { id: 's1', name: 'review', description: 'd', updatedAt: '', fileCount: -1 },
                ],
              }
            : {
                id: 's1',
                name: 'review',
                description: 'd',
                body: '',
                createdAt: '',
                updatedAt: '',
                files: [{ path: 'ref', content: 5 }],
              },
        ),
      );
      const result =
        operation === 'load'
          ? store.load()
          : operation === 'get'
            ? store.get('s1')
            : store.save(
                { name: 'review', description: 'd', body: '' },
                operation === 'update' ? 's1' : undefined,
              );
      await expect(result).rejects.toThrow();
      expect(store.items).toEqual([]);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('accepts only slug names', () => {
    expect(SKILL_NAME_PATTERN.test('code-review')).toBe(true);
    for (const name of ['../x', 'Upper', 'a--b', '-a', 'a/b', '']) {
      expect(SKILL_NAME_PATTERN.test(name), name).toBe(false);
    }
  });

  it('encodes skill IDs taken from the URL before using them in an API path', async () => {
    const store = useSkillsStore();
    await store.get('../users');
    expect(calls.map((call) => call.url)).toEqual(['/api/skills/..%2Fusers']);
  });
});
