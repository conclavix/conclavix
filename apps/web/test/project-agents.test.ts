import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, ref } from 'vue';
import { createRouter, createMemoryHistory } from 'vue-router';
import { createVuetify } from 'vuetify';
import type { ProjectAgent } from '../src/api/types';
import ProjectAgentsTab from '../src/components/projects/ProjectAgentsTab.vue';
import {
  assigneeOptions,
  disabledAgentIds,
  sourceLabel,
  toggleIntent,
} from '../src/projects/agents';

const loadProjectAgents = vi.hoisted(() => vi.fn());
const setProjectAgent = vi.hoisted(() => vi.fn());
vi.mock('../src/projects/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/projects/agents')>()),
  loadProjectAgents,
  setProjectAgent,
}));
vi.mock('../src/api/avatars', () => ({
  avatarColor: () => 'primary',
  initials: (name: string) => name.slice(0, 2),
  loadAvatar: vi.fn(),
}));
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);
vi.stubGlobal('visualViewport', Object.assign(new EventTarget(), { width: 1024, height: 768 }));

const agent = (overrides: Partial<ProjectAgent> = {}): ProjectAgent => ({
  id: 'a1',
  name: 'Reviewer',
  role: 'reviewer',
  title: 'PR reviewer',
  status: 'active',
  avatarUrl: null,
  projectDefault: 'disabled',
  enabled: false,
  source: 'default',
  override: null,
  isLead: false,
  openIssues: 0,
  ...overrides,
});

describe('project agent logic', () => {
  it('labels where the state comes from', () => {
    expect(sourceLabel(agent())).toBe('agent default (off)');
    expect(sourceLabel(agent({ source: 'project', override: true, enabled: true }))).toBe(
      'project override',
    );
    expect(sourceLabel(agent({ isLead: true, enabled: true }))).toBe('lead · always on');
  });

  it('stores an override only when it differs from the agent default', () => {
    expect(toggleIntent(agent(), true)).toEqual({ override: true, confirm: null });
    const on = agent({ enabled: true, source: 'project', override: true });
    expect(toggleIntent(on, false)).toEqual({ override: null, confirm: null });
    const byDefault = agent({ projectDefault: 'enabled', enabled: true });
    expect(toggleIntent(byDefault, false).override).toBe(false);
  });

  it('asks before disabling an agent with open issues, naming the count', () => {
    const busy = agent({ projectDefault: 'enabled', enabled: true, openIssues: 3 });
    const intent = toggleIntent(busy, false);
    expect(intent.override).toBe(false);
    expect(intent.confirm).toContain('3 open issues');
    expect(toggleIntent(agent({ enabled: true, openIssues: 1 }), false).confirm).toContain(
      '1 open issue ',
    );
    expect(toggleIntent(busy, true).confirm).toBeNull();
  });

  it('disables picker entries for agents not enabled, except the current assignee', () => {
    const all = [
      { id: 'a1', name: 'Reviewer', role: 'reviewer', status: 'active' },
      { id: 'a2', name: 'Dev', role: 'engineer', status: 'active' },
      { id: 'a3', name: 'Old', role: 'engineer', status: 'paused' },
    ];
    const access = [
      agent(),
      agent({ id: 'a2', name: 'Dev', enabled: true }),
      agent({ id: 'a3', name: 'Old' }),
    ];
    const options = assigneeOptions(all, access, 'a3');
    expect(options.map((option) => option.disabled)).toEqual([true, false, false]);
    expect(options[0]?.subtitle).toContain('not enabled in this project');
    expect(assigneeOptions(all, null, null).every((option) => !option.disabled)).toBe(true);
    expect([...disabledAgentIds(access)]).toEqual(['a1', 'a3']);
  });
});

describe('project agents tab', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  async function mount(items: ProjectAgent[], readOnly = false) {
    loadProjectAgents.mockResolvedValue(items);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/agents/:agentId', name: 'agent', component: { render: () => null } }],
    });
    createApp({ render: () => h(ProjectAgentsTab, { projectId: 'p1', readOnly }) })
      .use(createVuetify())
      .use(router)
      .mount(host);
    await flush();
    await nextTick();
    return host;
  }

  const switchOf = (host: HTMLElement, name: string) =>
    host.querySelector<HTMLInputElement>(`[data-test="project-agent-${name}"] input`);

  it('locks the lead and enables an agent with one click', async () => {
    const lead = agent({
      id: 'l',
      name: 'CEO',
      isLead: true,
      enabled: true,
      projectDefault: 'enabled',
    });
    const host = await mount([lead, agent()]);
    expect(switchOf(host, 'CEO')?.disabled).toBe(true);
    setProjectAgent.mockResolvedValue(agent({ enabled: true, source: 'project', override: true }));
    switchOf(host, 'Reviewer')?.click();
    await flush();
    expect(setProjectAgent).toHaveBeenCalledWith('p1', 'a1', true);
    await nextTick();
    expect(host.textContent).toContain('project override');
  });

  it('warns with the open issue count before disabling', async () => {
    const busy = agent({ projectDefault: 'enabled', enabled: true, openIssues: 2 });
    const host = await mount([busy]);
    switchOf(host, 'Reviewer')?.click();
    await flush();
    await nextTick();
    expect(setProjectAgent).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-test="disable-warning"]')?.textContent).toContain(
      '2 open issues',
    );
    setProjectAgent.mockResolvedValue({
      ...busy,
      enabled: false,
      source: 'project',
      override: false,
    });
    document.body.querySelector<HTMLButtonElement>('[data-test="confirm-disable"]')?.click();
    await flush();
    expect(setProjectAgent).toHaveBeenCalledWith('p1', 'a1', false);
  });

  it('is read only for roles without the agents capability', async () => {
    const host = await mount([agent({ source: 'project', override: false })], true);
    expect(host.querySelector('[data-test="project-agents-read-only"]')).not.toBeNull();
    expect(switchOf(host, 'Reviewer')?.disabled).toBe(true);
    expect(host.querySelector('[data-test="agent-reset"]')).toBeNull();
  });

  it('drops a late answer for a project the tab has already left', async () => {
    let releaseFirst: (items: ProjectAgent[]) => void = () => {};
    loadProjectAgents
      .mockImplementationOnce(() => new Promise((resolve) => (releaseFirst = resolve)))
      .mockResolvedValueOnce([agent({ id: 'b1', name: 'Bravo', enabled: true })]);
    const projectId = ref('p1');
    const changed = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/agents/:agentId', name: 'agent', component: { render: () => null } }],
    });
    createApp({
      render: () =>
        h(ProjectAgentsTab, { projectId: projectId.value, readOnly: false, onChanged: changed }),
    })
      .use(createVuetify())
      .use(router)
      .mount(host);
    await nextTick();
    projectId.value = 'p2';
    await flush();
    releaseFirst([agent({ name: 'Alpha' })]);
    await flush();
    await nextTick();
    expect(host.textContent).toContain('Bravo');
    expect(host.textContent).not.toContain('Alpha');
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('keeps each switch locked until its own request ends', async () => {
    const second = agent({ id: 'a2', name: 'Second' });
    const host = await mount([agent(), second]);
    const releases: ((value: ProjectAgent) => void)[] = [];
    setProjectAgent.mockImplementation(
      () => new Promise<ProjectAgent>((resolve) => releases.push(resolve)),
    );
    switchOf(host, 'Reviewer')?.click();
    await nextTick();
    switchOf(host, 'Second')?.click();
    await nextTick();
    releases[0]?.(agent({ enabled: true, source: 'project', override: true }));
    await flush();
    await nextTick();
    expect(switchOf(host, 'Reviewer')?.disabled).toBe(false);
    expect(switchOf(host, 'Second')?.disabled).toBe(true);
  });
});
