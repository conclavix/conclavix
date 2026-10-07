import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, ref } from 'vue';
import { createVuetify } from 'vuetify';
import type { AgentDetail } from '../src/api/types';
import AgentSettingsTab from '../src/components/agents/AgentSettingsTab.vue';

const patchAgent = vi.hoisted(() => vi.fn());
vi.mock('../src/agents/api', () => ({ patchAgent, errorText: String }));
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);
vi.stubGlobal('visualViewport', Object.assign(new EventTarget(), { width: 1024, height: 768 }));

const detail = (id: string, name: string, secret: string): AgentDetail => ({
  id,
  name,
  role: 'engineer',
  title: '',
  status: 'active',
  avatarUrl: null,
  reportsTo: null,
  adapter: { type: 'claude_cli', gatewayKeySecret: secret },
  limits: { maxIdleRunsPerIssue: 4, maxCostPerRunUsd: 2, maxCostPerDayUsd: 20 },
  instructions: '',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('agent settings tab', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('rebuilds the form when the view swaps in another agent', async () => {
    const agent = ref(detail('a', 'Alice', 'A_KEY'));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp({
      render: () => h(AgentSettingsTab, { agent: agent.value, agents: [], models: [] }),
    });
    app.use(createVuetify()).mount(host);
    await nextTick();

    agent.value = detail('b', 'Bob', 'B_KEY');
    await nextTick();
    patchAgent.mockResolvedValue(agent.value);
    const save = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Save settings'),
    );
    save?.click();
    await flush();
    await flush();

    expect(patchAgent).toHaveBeenCalledTimes(1);
    const [id, body] = patchAgent.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('b');
    expect(body).toMatchObject({
      name: 'Bob',
      adapter: { type: 'claude_cli', gatewayKeySecret: 'B_KEY' },
    });
    app.unmount();
  });
});
