import { createPinia } from 'pinia';
import { createApp, nextTick, type App } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminSkillSourcesView from '../src/views/admin/AdminSkillSourcesView.vue';
import { tokenStore } from '../src/api/client';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
  }
}

const source = {
  id: 's1',
  name: 'Skills Directory',
  provider: 'skillsdirectory',
  baseUrl: 'https://www.skillsdirectory.com/api/v1',
  baseUrlIsDefault: true,
  enabled: true,
  hasApiKey: true,
  createdAt: '',
  updatedAt: '',
};

describe('skill directories admin page', () => {
  let app: App;
  let root: HTMLDivElement;
  let requests: { url: string; method: string }[];
  let testResponse: Response;

  beforeEach(async () => {
    requests = [];
    testResponse = json({
      ok: true,
      tier: 'free',
      keyStatus: 'active',
      quota: { remaining: 87, limit: 100, tier: 'free', resetAt: null },
    });
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
        requests.push({ url, method: init.method ?? 'GET' });
        if (url === '/api/skill-sources') {
          return json({
            items: [source],
            providers: [
              {
                id: 'skillsdirectory',
                label: 'Skills Directory',
                defaultBaseUrl: source.baseUrl,
                docsUrl: 'https://www.skillsdirectory.com/api-docs',
              },
            ],
          });
        }
        if (url === '/api/skill-sources/s1/test') return testResponse;
        return json({ error: 'not_found', message: 'nope' }, 404);
      }),
    );
    root = document.createElement('div');
    document.body.append(root);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: { render: () => null } },
        { path: '/skills', name: 'skills', component: { render: () => null } },
      ],
    });
    await router.push('/');
    app = createApp(AdminSkillSourcesView).use(createPinia()).use(router).use(createVuetify());
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

  const testButton = () => {
    const button = root.querySelector<HTMLButtonElement>('[data-test="source-test"]');
    if (!button) throw new Error('missing test button');
    return button;
  };

  it('lists sources with key presence only and tests the connection', async () => {
    expect(root.textContent).toContain('Skills Directory');
    expect(root.textContent).toContain('(default)');
    expect(root.textContent).toContain('set');
    testButton().click();
    await flush();
    expect(requests).toContainEqual({ url: '/api/skill-sources/s1/test', method: 'POST' });
    expect(root.querySelector('[data-test="source-test-result"]')?.textContent).toContain(
      'Connected (free plan) · 87 of 100 requests left today',
    );
  });

  it('shows why a connection test failed', async () => {
    testResponse = json(
      { error: 'directory_auth_failed', message: 'The directory rejected the API key' },
      502,
    );
    testButton().click();
    await flush();
    expect(root.querySelector('[data-test="source-test-result"]')?.textContent).toContain(
      'rejected the API key',
    );
  });
});
