import { createPinia } from 'pinia';
import { createApp, nextTick, type App } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SkillsView from '../src/views/SkillsView.vue';
import { tokenStore } from '../src/api/client';

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Missing test element');
  return value;
}

const skill = (id: string) => ({
  id,
  name: id,
  description: `Description ${id}`,
  body: `Instructions ${id}`,
  files: [{ path: 'reference.md', content: 'preserve me' }],
  createdAt: '',
  updatedAt: '',
});
const json = (value: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(value), { status });
const deferred = () => {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => (resolve = done));
  return { promise, resolve };
};
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

describe('skills editor', () => {
  let app: App;
  let root: HTMLDivElement;
  let requests: { url: string; method: string; body: unknown }[];
  let responses: Map<string, Promise<Response>>;
  let failRefresh: boolean;

  beforeEach(async () => {
    requests = [];
    responses = new Map();
    failRefresh = false;
    tokenStore.set('t'.repeat(32));
    vi.stubGlobal('visualViewport', undefined);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? 'GET';
        const body: unknown = init.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ url, method, body });
        const pending = responses.get(`${method} ${url}`);
        if (pending) return pending;
        if (method === 'DELETE') return json(null, 204);
        if (url === '/api/agents' && method === 'GET') {
          return json({
            items: [
              { id: 'a2', name: 'Bob', skillIds: ['alpha'] },
              { id: 'a1', name: 'Alice', skillIds: ['alpha', 'beta'] },
            ],
          });
        }
        if (url === '/api/skills' && method === 'GET') {
          return failRefresh
            ? json({}, 503)
            : json({
                items: ['alpha', 'beta'].map((id) => ({ ...skill(id), fileCount: 1 })),
              });
        }
        return json(
          skill(url.split('/').at(-1) === 'skills' ? 'created' : required(url.split('/').at(-1))),
        );
      }),
    );
    root = document.createElement('div');
    document.body.append(root);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: { render: () => null } },
        { path: '/agents/:agentId', name: 'agent', component: { render: () => null } },
      ],
    });
    await router.push('/');
    app = createApp(SkillsView).use(createPinia()).use(router).use(createVuetify());
    app.mount(root);
    await flush();
  });

  afterEach(() => {
    app.unmount();
    root.remove();
    tokenStore.clear();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  function button(label: string): HTMLButtonElement {
    const result = [...document.querySelectorAll('button')].find(
      (item) => item.textContent?.trim() === label,
    );
    if (!result) throw new Error(`Missing button ${label}`);
    return result;
  }
  async function open(id: string) {
    const item = [...root.querySelectorAll<HTMLElement>('.v-list-item')].find((item) =>
      item.textContent?.includes(`Description ${id}`),
    );
    if (!item) throw new Error(`Missing skill ${id}`);
    item.click();
    await flush();
  }
  async function editName(name: string) {
    const input = required(root.querySelector('input'));
    input.value = name;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
  }
  async function save() {
    button('Save').click();
    await flush();
  }

  it('updates through the view without sending loaded supporting files', async () => {
    await open('alpha');
    expect(root.textContent).toContain('reference.md');
    await editName('renamed');
    await save();
    expect(requests.find((request) => request.method === 'PATCH')).toEqual({
      url: '/api/skills/alpha',
      method: 'PATCH',
      body: { name: 'renamed', description: 'Description alpha', body: 'Instructions alpha' },
    });
  });

  it.each([false, true])('ignores stale open completion (failure: %s)', async (failure) => {
    const old = deferred();
    responses.set('GET /api/skills/alpha', old.promise);
    await open('alpha');
    await open('beta');
    old.resolve(failure ? json({ message: 'stale failure' }, 500) : json(skill('alpha')));
    await flush();
    expect(root.querySelector('input')?.value).toBe('beta');
    expect(root.querySelector('[data-test="skill-error"]')).toBeNull();
    await save();
    expect(requests.find((request) => request.method === 'PATCH')?.url).toBe('/api/skills/beta');
  });

  it.each(['New', 'Close'])('invalidates pending opens when choosing %s', async (action) => {
    await open('beta');
    const old = deferred();
    responses.set('GET /api/skills/alpha', old.promise);
    await open('alpha');
    button(action).click();
    await flush();
    old.resolve(json(skill('alpha')));
    await flush();
    if (action === 'New') expect(root.querySelector('input')?.value).toBe('');
    else expect(root.querySelector('form')).toBeNull();
  });

  it('prevents saving the old draft while another skill is loading', async () => {
    await open('alpha');
    const pending = deferred();
    responses.set('GET /api/skills/beta', pending.promise);
    await open('beta');
    expect(button('Save').disabled).toBe(true);
    required(root.querySelector('form')).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await flush();
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(0);
    pending.resolve(json(skill('beta')));
    await flush();
    await save();
    expect(requests.find((request) => request.method === 'PATCH')?.url).toBe('/api/skills/beta');
  });

  it('locks navigation and duplicate submits throughout saving', async () => {
    await open('alpha');
    const pending = deferred();
    responses.set('PATCH /api/skills/alpha', pending.promise);
    await save();
    expect(button('New').disabled).toBe(true);
    expect(button('Close').disabled).toBe(true);
    expect(button('Delete').disabled).toBe(true);
    await open('beta');
    required(root.querySelector('form')).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await flush();
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
    expect(requests.some((request) => request.url === '/api/skills/beta')).toBe(false);
    pending.resolve(json(skill('alpha')));
    await flush();
    expect(root.querySelector('input')?.value).toBe('alpha');
  });

  it('closes a deleted editor even when refreshing fails', async () => {
    await open('alpha');
    button('Delete').click();
    await flush();
    failRefresh = true;
    const confirm = required(
      document.querySelector<HTMLButtonElement>('.v-dialog button:last-child'),
    );
    confirm.click();
    await flush();
    expect(requests.filter((request) => request.method === 'DELETE')).toHaveLength(1);
    expect(root.querySelector('form')).toBeNull();
    expect(root.querySelector('[data-test="skill-error"]')).toBeNull();
    expect(root.textContent).toContain('Could not refresh');
    expect(
      [...root.querySelectorAll('.v-list-item')].some((item) =>
        item.textContent?.includes('Description alpha'),
      ),
    ).toBe(false);
  });

  it('keeps a created identity after refresh failure so the next save uses PATCH', async () => {
    button('New').click();
    await flush();
    await editName('created');
    const description = required(root.querySelectorAll('input')[1]);
    description.value = 'Description';
    description.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    failRefresh = true;
    await save();
    expect(root.textContent).toContain('Could not refresh');
    expect(root.textContent).toContain('Edit created');
    await save();
    expect(
      requests
        .filter((request) => request.method !== 'GET')
        .map((request) => `${request.method} ${request.url}`),
    ).toEqual(['POST /api/skills', 'PATCH /api/skills/created']);
    failRefresh = false;
    button('Refresh').click();
    await flush();
    expect(root.textContent).not.toContain('Could not refresh');
  });

  it('shows which agents use each skill', async () => {
    const chips = [...root.querySelectorAll('[data-test="skill-usage"]')].map((chip) =>
      chip.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(chips).toEqual(['2 agents', '1 agent']);
    await open('alpha');
    const usedBy = required(root.querySelector('[data-test="skill-used-by"]'));
    expect(usedBy.textContent?.replace(/\s+/g, ' ')).toContain('Used by Alice, Bob');
    expect(usedBy.querySelector('a')?.getAttribute('href')).toBe('/agents/a1');
  });
});
