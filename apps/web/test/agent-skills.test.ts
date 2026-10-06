import { createPinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, ref, type App } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import {
  addSkill,
  assignedSkills,
  availableSkills,
  canEditAgents,
  canWriteMemories,
  removeSkill,
  sameSkills,
  skillUsage,
  skillsErrorText,
  skillsPatch,
} from '../src/agents/skills';
import { ApiError } from '../src/api/client';
import type { AgentDetail, SkillSummary } from '../src/api/types';
import AgentSkillsTab from '../src/components/agents/AgentSkillsTab.vue';
import { useAuthStore } from '../src/stores/auth';

const patchAgent = vi.hoisted(() => vi.fn());
vi.mock('../src/agents/api', async (importActual) => ({
  ...(await importActual<typeof import('../src/agents/api')>()),
  patchAgent,
}));

const summary = (id: string, name: string): SkillSummary => ({
  id,
  name,
  description: `About ${name}`,
  fileCount: 0,
  updatedAt: '2026-01-01',
});
const library = [summary('s1', 'review'), summary('s2', 'deploy'), summary('s3', 'audit')];

describe('skill assignment logic', () => {
  it('adds once, removes, and keeps the order', () => {
    expect(addSkill(['s1'], 's2')).toEqual(['s1', 's2']);
    expect(addSkill(['s1', 's2'], 's1')).toEqual(['s1', 's2']);
    expect(removeSkill(['s1', 's2', 's3'], 's2')).toEqual(['s1', 's3']);
    expect(removeSkill(['s1'], 'missing')).toEqual(['s1']);
  });

  it('builds a patch only when the set of skills changed', () => {
    expect(skillsPatch(['s1', 's2'], ['s2', 's1'])).toBeNull();
    expect(skillsPatch([], [])).toBeNull();
    expect(skillsPatch(['s1'], ['s1', 's2'])).toEqual({ skillIds: ['s1', 's2'] });
    expect(skillsPatch(['s1', 's2'], [])).toEqual({ skillIds: [] });
    expect(sameSkills(['s1'], ['s2'])).toBe(false);
  });

  it('resolves names, keeps unknown IDs visible and offers only unassigned skills', () => {
    expect(assignedSkills(['s2', 'gone'], library, true)).toEqual([
      { id: 's2', name: 'deploy', description: 'About deploy', state: 'known' },
      { id: 'gone', name: 'gone', description: 'Not in the skill library', state: 'missing' },
    ]);
    expect(assignedSkills(['gone'], [], false)).toEqual([
      { id: 'gone', name: 'gone', description: '', state: 'unresolved' },
    ]);
    expect(availableSkills(['s2'], library).map((skill) => skill.name)).toEqual([
      'audit',
      'review',
    ]);
  });

  it('maps each skill to the agents using it', () => {
    const usage = skillUsage([
      { id: 'b', name: 'Bob', skillIds: ['s1'] },
      { id: 'a', name: 'Alice', skillIds: ['s1', 's2'] },
      { id: 'c', name: 'Carol' },
    ]);
    expect(usage['s1']?.map((agent) => agent.name)).toEqual(['Alice', 'Bob']);
    expect(usage['s2']?.map((agent) => agent.name)).toEqual(['Alice']);
    expect(usage['s3']).toBeUndefined();
  });

  it('gates editing by role', () => {
    expect(['owner', 'admin'].map(canEditAgents)).toEqual([true, true]);
    expect(['member', 'viewer', 'unknown', undefined].map(canEditAgents)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(['owner', 'admin', 'member'].map(canWriteMemories)).toEqual([true, true, true]);
    expect(['viewer', undefined].map(canWriteMemories)).toEqual([false, false]);
  });

  it('names unknown skills from a 422 and explains a 403', () => {
    const unknown = new ApiError('Unknown skill ids', 422, 'unprocessable', {
      missing: ['s3', 'zz'],
    });
    expect(skillsErrorText(unknown, library)).toBe(
      'Unknown skill ids: audit, zz. Reload the skill library and remove them.',
    );
    expect(skillsErrorText(new ApiError('Forbidden', 403), library)).toMatch(/role may not/);
    expect(skillsErrorText(new Error('boom'), library)).toBe('boom');
  });
});

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);
vi.stubGlobal('visualViewport', Object.assign(new EventTarget(), { width: 1024, height: 768 }));

const agent = (skillIds: string[]): AgentDetail => ({
  id: 'a1',
  name: 'Alice',
  role: 'engineer',
  title: '',
  status: 'active',
  avatarUrl: null,
  reportsTo: null,
  adapter: { type: 'claude_cli' },
  limits: { maxIdleRunsPerIssue: 4, maxCostPerRunUsd: 2, maxCostPerDayUsd: 20 },
  skillIds,
  instructions: '',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
});

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
};
const button = (root: HTMLElement, label: string): HTMLButtonElement | undefined =>
  [...root.querySelectorAll('button')].find((item) => item.textContent?.includes(label));

describe('agent skills tab', () => {
  let app: App | undefined;
  let host: HTMLDivElement;

  beforeEach(() => {
    patchAgent.mockReset();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ items: library }), { status: 200 })),
    );
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    app?.unmount();
    document.body.innerHTML = '';
  });

  async function mount(readOnly: boolean, saved: string[]) {
    const current = ref(agent(saved));
    const draft = ref([...saved]);
    const updates: AgentDetail[] = [];
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: { render: () => null } },
        { path: '/skills', name: 'skills', component: { render: () => null } },
      ],
    });
    app = createApp({
      render: () =>
        h(AgentSkillsTab, {
          agent: current.value,
          readOnly,
          modelValue: draft.value,
          'onUpdate:modelValue': (value: string[]) => (draft.value = value),
          onUpdated: (next: AgentDetail) => {
            updates.push(next);
            current.value = next;
          },
        }),
    });
    app.use(createPinia()).use(router).use(createVuetify());
    await router.push('/');
    app.mount(host);
    await flush();
    return { draft, updates, current };
  }

  it('removes a skill and saves only the changed list', async () => {
    const { draft, updates } = await mount(false, ['s1', 's2']);
    expect(host.querySelectorAll('[data-test="assigned-skill"]')).toHaveLength(2);
    expect(host.textContent).toContain('review');
    expect(button(host, 'Save skills')?.disabled).toBe(true);

    host.querySelector<HTMLButtonElement>('[aria-label="Remove review"]')?.click();
    await flush();
    expect(draft.value).toEqual(['s2']);
    expect(host.textContent).toContain('Unsaved changes');

    patchAgent.mockResolvedValue(agent(['s2']));
    button(host, 'Save skills')?.click();
    await flush();
    expect(patchAgent).toHaveBeenCalledWith('a1', { skillIds: ['s2'] });
    expect(updates.map((next) => next.skillIds)).toEqual([['s2']]);
  });

  it('shows the API error when the save is rejected', async () => {
    const { draft } = await mount(false, []);
    draft.value = ['s3'];
    await flush();
    patchAgent.mockRejectedValue(
      new ApiError('Unknown skill ids', 422, 'unprocessable', { missing: ['s3'] }),
    );
    button(host, 'Save skills')?.click();
    await flush();
    expect(host.querySelector('[data-test="skills-error"]')?.textContent).toContain(
      'Unknown skill ids: audit',
    );
  });

  it('is read-only without the agents capability', async () => {
    await mount(true, ['s1']);
    expect(host.querySelector('[data-test="skills-read-only"]')).not.toBeNull();
    expect(host.querySelector('[data-test="skill-picker"]')).toBeNull();
    expect(host.querySelector('[data-test="remove-skill"]')).toBeNull();
    expect(button(host, 'Save skills')).toBeUndefined();
    expect(host.querySelector('a[href="/skills?skill=s1"]')?.textContent).toContain('review');
  });
});

describe('skill library links and agent page guard', () => {
  let app: App | undefined;
  let host: HTMLDivElement;
  let agentsFail: boolean;

  const fullSkill = (id: string) => ({
    ...summary(id, `name-${id}`),
    body: '',
    files: [],
    createdAt: '2026-01-01',
  });

  beforeEach(() => {
    patchAgent.mockReset();
    agentsFail = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const ok = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
        if (url === '/api/skills') return ok({ items: library });
        if (url.startsWith('/api/skills/')) return ok(fullSkill(url.split('/').at(-1) ?? ''));
        if (url === '/api/agents') {
          return agentsFail
            ? new Response(JSON.stringify({ message: 'down' }), { status: 503 })
            : ok({ items: [agent(['s1'])] });
        }
        if (url === '/api/agents/a1') return ok(agent(['s1', 's2']));
        if (url === '/api/agents/a2') return ok({ ...agent([]), id: 'a2', name: 'Bob' });
        if (url === '/api/models') return ok({ items: [] });
        return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
      }),
    );
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    app?.unmount();
    app = undefined;
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  async function mountRoute(path: string) {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/agents', name: 'agents', component: { render: () => null } },
        {
          path: '/agents/:agentId',
          name: 'agent',
          component: () => import('../src/views/AgentView.vue'),
          props: true,
        },
        {
          path: '/skills',
          name: 'skills',
          component: () => import('../src/views/SkillsView.vue'),
          props: (route) => ({ skill: route.query['skill'] }),
        },
        { path: '/issues/:issueKey', name: 'issue', component: { render: () => null } },
        { path: '/runs/:runId', name: 'run', component: { render: () => null } },
      ],
    });
    const { RouterView } = await import('vue-router');
    app = createApp({ render: () => h(RouterView) });
    const pinia = createPinia();
    app.use(pinia).use(router).use(createVuetify());
    useAuthStore(pinia).me = { kind: 'user', id: 'u1', role: 'owner', mfaRequired: false };
    await router.push(path);
    app.mount(host);
    for (let i = 0; i < 4; i++) await flush();
    return router;
  }

  it('opens the skill named in ?skill= and lists its agents', async () => {
    await mountRoute('/skills?skill=s1');
    expect(host.textContent).toContain('Edit name-s1');
    const usedBy = host.querySelector('[data-test="skill-used-by"]');
    expect(usedBy?.textContent).toContain('Alice');
  });

  it('does not claim a skill is unused when the agents cannot be loaded', async () => {
    agentsFail = true;
    await mountRoute('/skills?skill=s1');
    const usedBy = host.querySelector('[data-test="skill-used-by"]');
    expect(usedBy?.textContent).not.toContain('Not assigned');
    expect(usedBy?.textContent).toContain('Could not load');
  });

  it('marks unsaved skill changes and asks before leaving the agent', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const router = await mountRoute('/agents/a1?tab=skills');
    expect(host.querySelectorAll('[data-test="assigned-skill"]')).toHaveLength(2);
    expect(host.querySelector('[data-test="tab-skills"]')?.textContent).not.toContain('*');

    host.querySelector<HTMLButtonElement>('[aria-label="Remove review"]')?.click();
    await flush();
    expect(host.querySelector('[data-test="tab-skills"]')?.textContent).toContain('*');

    await router.push({ name: 'agents' });
    expect(confirm).toHaveBeenCalledOnce();
    expect(router.currentRoute.value.name).toBe('agent');
  });

  it('gives the next agent a fresh skills tab while a save is pending', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let finish!: (value: AgentDetail) => void;
    patchAgent.mockReturnValue(new Promise<AgentDetail>((resolve) => (finish = resolve)));
    const router = await mountRoute('/agents/a1?tab=skills');
    host.querySelector<HTMLButtonElement>('[aria-label="Remove review"]')?.click();
    await flush();
    button(host, 'Save skills')?.click();
    await flush();
    expect(patchAgent).toHaveBeenCalledWith('a1', { skillIds: ['s2'] });

    await router.push('/agents/a2?tab=skills');
    for (let i = 0; i < 4; i++) await flush();
    expect(host.querySelector('[data-test="agent-name"]')?.textContent).toBe('Bob');

    finish(agent(['s2']));
    for (let i = 0; i < 3; i++) await flush();
    expect(host.querySelector('[data-test="agent-name"]')?.textContent).toBe('Bob');
    expect(host.querySelector('[data-test="no-skills"]')).not.toBeNull();
    expect(host.querySelector('[data-test="tab-skills"]')?.textContent).not.toContain('*');
    expect(document.body.textContent).not.toContain('Skills saved');
  });

  it('ignores a save response for an agent the page has left', async () => {
    let finish!: (value: AgentDetail) => void;
    patchAgent.mockReturnValue(new Promise<AgentDetail>((resolve) => (finish = resolve)));
    const router = await mountRoute('/agents/a1?tab=settings');
    button(host, 'Save settings')?.click();
    await flush();
    expect(patchAgent).toHaveBeenCalledWith('a1', expect.any(Object));

    await router.push('/agents/a2?tab=settings');
    for (let i = 0; i < 4; i++) await flush();
    expect(host.querySelector('[data-test="agent-name"]')?.textContent).toBe('Bob');

    finish(agent(['s1']));
    for (let i = 0; i < 3; i++) await flush();
    expect(host.querySelector('[data-test="agent-name"]')?.textContent).toBe('Bob');
  });
});

describe('agent skills tab without a library', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('does not call assigned skills missing when the library failed to load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ message: 'down' }), { status: 503 })),
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: { render: () => null } },
        { path: '/skills', name: 'skills', component: { render: () => null } },
      ],
    });
    const app = createApp({
      render: () => h(AgentSkillsTab, { agent: agent(['s1']), readOnly: true, modelValue: ['s1'] }),
    });
    app.use(createPinia()).use(router).use(createVuetify());
    await router.push('/');
    app.mount(host);
    for (let i = 0; i < 3; i++) await flush();
    expect(host.textContent).toContain('Could not load the skill library');
    expect(host.textContent).not.toContain('Not in the skill library');
    expect(host.querySelector('[data-test="assigned-skill"] .text-error')).toBeNull();
    app.unmount();
  });
});
