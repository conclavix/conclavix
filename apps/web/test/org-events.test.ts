import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import type { AgentLink, GraphAgent } from '../src/api/org-graph';
import { applyGraphEvent } from '../src/org/events';

function refs() {
  return {
    agents: ref<Record<string, GraphAgent>>({
      a: { id: 'a', name: 'A', role: '', title: '', status: 'active', model: null, position: null },
    }),
    links: ref<AgentLink[]>([{ id: 'pending-1', from: 'a', to: 'b', type: 'delegates' }]),
    leadAgentId: ref<string | null>(null),
  };
}

describe('graph stream events', () => {
  it.each([
    { status: 'broken' },
    { model: 7 },
    { position: 'x' },
    { position: { x: 1 } },
    { position: { x: Infinity, y: 0 } },
    { name: null },
  ])('ignores malformed agent patches: %j', (patch) => {
    const state = refs();
    applyGraphEvent(state, 'org_layout', { agentId: 'a', x: 5, y: 6 });
    const original = { ...state.agents.value['a'] };
    expect(applyGraphEvent(state, 'agent', { id: 'a', ...patch })).toBe(false);
    expect(state.agents.value['a']).toEqual(original);
  });

  it('accepts nullable fields and strips fields outside the agent patch', () => {
    const state = refs();
    applyGraphEvent(state, 'agent', { id: 'a', model: 'm', position: { x: 1, y: 2 } });
    expect(state.agents.value['a']).toMatchObject({ model: 'm', position: { x: 1, y: 2 } });
    applyGraphEvent(state, 'agent', {
      id: 'a',
      model: null,
      position: null,
      reports: ['b'],
      name: undefined,
    });
    expect(state.agents.value['a']).toMatchObject({ name: 'A', model: null, position: null });
    expect(state.agents.value['a']).not.toHaveProperty('reports');
  });

  it('upserts a created link, replacing the matching optimistic one', () => {
    const state = refs();
    const link = { id: 'l1', from: 'a', to: 'b', type: 'delegates' };
    expect(applyGraphEvent(state, 'agent_link.created', { link })).toBe(true);
    expect(applyGraphEvent(state, 'agent_link', link)).toBe(true);
    expect(state.links.value).toEqual([link]);
  });

  it('keeps wakeOnReport from streamed links and ignores non-boolean values', () => {
    const state = refs();
    const link = { id: 'r1', from: 'b', to: 'a', type: 'reports', wakeOnReport: true };
    expect(applyGraphEvent(state, 'agent_link', link)).toBe(true);
    expect(state.links.value.find((item) => item.id === 'r1')).toEqual(link);
    applyGraphEvent(state, 'agent_link', { ...link, wakeOnReport: 'yes' });
    expect(state.links.value.find((item) => item.id === 'r1')).not.toHaveProperty('wakeOnReport');
  });

  it('removes a deleted link', () => {
    const state = refs();
    expect(applyGraphEvent(state, 'agent_link', { id: 'pending-1', deleted: true })).toBe(true);
    expect(state.links.value).toEqual([]);
  });

  it('applies the per-agent org_layout and org events of the lead-agent API', () => {
    const state = refs();
    applyGraphEvent(state, 'org_layout', { agentId: 'a', x: 7, y: 8 });
    applyGraphEvent(state, 'org_layout', { agentId: 'a', deleted: true });
    applyGraphEvent(state, 'org', { leadAgentId: 'a' });
    expect(state.agents.value['a']?.position).toEqual({ x: 7, y: 8 });
    expect(state.leadAgentId.value).toBe('a');
  });

  it('applies layout, lead and agent changes and ignores unknown events', () => {
    const state = refs();
    applyGraphEvent(state, 'org_layout', { positions: [{ agentId: 'a', x: 5, y: 6 }] });
    applyGraphEvent(state, 'org.lead', { leadAgentId: 'a' });
    applyGraphEvent(state, 'agent', { id: 'a', status: 'paused', adapter: { model: 'm1' } });
    expect(state.agents.value['a']).toMatchObject({
      position: { x: 5, y: 6 },
      status: 'paused',
      model: 'm1',
    });
    expect(state.leadAgentId.value).toBe('a');
    expect(applyGraphEvent(state, 'run', { id: 'r' })).toBe(false);
    expect(applyGraphEvent(state, 'agent_link', { id: 'x', from: 'a' })).toBe(false);
  });
});
