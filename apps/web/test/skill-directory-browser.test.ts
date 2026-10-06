import { createPinia } from 'pinia';
import { createApp, nextTick, type App } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SkillDirectoryBrowser from '../src/components/skills/SkillDirectoryBrowser.vue';
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
const item = {
  externalId: 'sk_1',
  slug: 'pdf-tools',
  name: 'PDF Tools',
  description: 'Extract text',
  category: 'documents',
  author: { name: 'Ada', url: null, avatarUrl: 'http://insecure.example/a.png' },
  tags: ['pdf'],
  stars: 42,
  votes: 1,
  views: 2,
  verified: true,
  securityGrade: null,
  securityScore: null,
  githubUrl: null,
  webUrl: 'https://www.skillsdirectory.com/skills/pdf-tools',
  updatedAt: null,
};
const quota = { remaining: 87, limit: null, tier: 'free', resetAt: null };

describe('skill directory browser', () => {
  let app: App;
  let root: HTMLDivElement;
  let requests: { url: string; method: string; body: unknown }[];
  let content: unknown;
  let imported: string[];
  let failCategories = false;

  beforeEach(async () => {
    requests = [];
    imported = [];
    content = {
      available: false,
      reason: 'tier',
      message: 'This directory only provides skill content on a paid plan',
    };
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
      'IntersectionObserver',
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
        if (url === '/api/skill-sources') {
          return json({
            items: [source, { ...source, id: 's2', name: 'Off', enabled: false }],
            providers: [],
          });
        }
        if (url === '/api/skill-sources/s1/categories' && failCategories) {
          return json(
            { error: 'directory_rate_limited', message: 'limit', details: { resetAt: null } },
            429,
          );
        }
        if (url === '/api/skill-sources/s1/categories') {
          return json({
            items: [{ slug: 'documents', name: 'Documents', description: null }],
            cached: false,
          });
        }
        if (url.startsWith('/api/skill-sources/s1/skills?')) {
          return json({
            items: [{ ...item, importedSkillId: null }],
            page: 1,
            limit: 12,
            total: 1,
            totalPages: 1,
            hasNextPage: false,
            quota,
            cached: false,
          });
        }
        if (url === '/api/skill-sources/s1/skills/pdf-tools') {
          return json({ skill: item, content, importedSkillId: null, quota, cached: true });
        }
        if (url === '/api/skill-sources/s1/import') {
          return json(
            {
              skill: {
                id: 'new-skill',
                name: 'pdf-tools',
                description: 'Extract text',
                body: '# PDF',
                files: [],
                source: null,
                createdAt: '',
                updatedAt: '',
              },
              replaced: false,
            },
            201,
          );
        }
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
        {
          path: '/admin/skill-directories',
          name: 'admin-skill-directories',
          component: { render: () => null },
        },
      ],
    });
    await router.push('/');
    app = createApp(SkillDirectoryBrowser, { onImported: (id: string) => imported.push(id) })
      .use(createPinia())
      .use(router)
      .use(createVuetify());
    app.mount(root);
    await flush();
  });

  afterEach(() => {
    failCategories = false;
    app.unmount();
    root.remove();
    tokenStore.clear();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  const openCard = async () => {
    const card = root.querySelector<HTMLElement>('[data-test="directory-card-pdf-tools"]');
    if (!card) throw new Error('missing card');
    card.click();
    await flush();
  };
  const importButton = () => {
    const button = document.querySelector<HTMLButtonElement>('[data-test="directory-import"]');
    if (!button) throw new Error('missing import button');
    return button;
  };

  it('lists enabled sources, searches and shows cards with the remaining budget', () => {
    expect(requests.map((request) => request.url)).toContain(
      '/api/skill-sources/s1/skills?sort=recent&page=1&limit=12',
    );
    expect(root.textContent).toContain('PDF Tools');
    expect(root.textContent).toContain('87 requests left today (free plan)');
    expect(root.querySelector('img')).toBeNull();
  });

  it('disables import on the free tier with the reason and a link to the directory', async () => {
    await openCard();
    expect(importButton().disabled).toBe(true);
    const notice = document.querySelector('[data-test="directory-no-content"]');
    expect(notice?.textContent).toContain(
      'This directory only provides skill content on a paid plan',
    );
    expect(notice?.querySelector('a')?.getAttribute('href')).toBe(item.webUrl);
  });

  it('imports available content only after an explicit confirmation', async () => {
    content = { available: true, content: '# PDF\n<script>x</script>', contentHash: 'h' };
    await openCard();
    const preview = document.querySelector('[data-test="directory-preview"]');
    expect(preview?.textContent).toContain('<script>x</script>');
    expect(preview?.querySelector('script')).toBeNull();
    expect(importButton().disabled).toBe(false);
    importButton().click();
    await flush();
    const submit = document.querySelector<HTMLButtonElement>(
      '[data-test="directory-import-submit"]',
    );
    expect(submit?.disabled).toBe(true);
    expect(document.body.textContent).toContain('becomes part of agent prompts');
    const confirm = document.querySelector<HTMLInputElement>(
      '[data-test="directory-import-confirm"] input',
    );
    confirm?.click();
    await flush();
    expect(submit?.disabled).toBe(false);
    submit?.click();
    await flush();
    const sent = requests.find((request) => request.url === '/api/skill-sources/s1/import');
    expect(sent?.body).toEqual({ slug: 'pdf-tools', name: 'pdf-tools', confirmUntrusted: true });
    expect(imported).toEqual(['new-skill']);
  });

  it('says why the categories are missing when loading them failed', async () => {
    app.unmount();
    failCategories = true;
    root = document.createElement('div');
    document.body.append(root);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { render: () => null } }],
    });
    await router.push('/');
    app = createApp(SkillDirectoryBrowser).use(createPinia()).use(router).use(createVuetify());
    app.mount(root);
    await flush();
    expect(root.querySelector('[data-test="directory-category"]')?.textContent).toContain(
      'Categories could not be loaded: The daily request limit of this directory is used up.',
    );
  });
});
