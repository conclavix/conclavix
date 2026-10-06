import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import * as api from '../src/api/org-graph';
import { HANDLES } from '../src/org/rules';
import { LAYOUT_SAVE_DELAY_MS } from '../src/org/layout-queue';
import { useOrgGraphStore } from '../src/stores/orgGraph';

vi.mock('../src/api/org-graph', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/org-graph')>()),
  fetchOrgGraph: vi.fn(),
  fetchOrg: vi.fn(),
  createLink: vi.fn(),
  deleteLink: vi.fn(),
  updateLink: vi.fn(),
  saveLayout: vi.fn(),
  setLead: vi.fn(),
  setAgentStatus: vi.fn(),
}));

const agent = (id: string, position: api.Position | null = { x: 0, y: 0 }): api.GraphAgent => ({
  id,
  name: id,
  role: '',
  title: '',
  status: 'active',
  model: null,
  position,
});

const graph = (): api.OrgGraph => ({
  leadAgentId: 'ceo',
  agents: [agent('ceo'), agent('cto', { x: 300, y: 0 }), agent('dev', { x: 600, y: 0 })],
  links: [{ id: 'l1', from: 'ceo', to: 'cto', type: 'delegates' }],
});

const delegate = (source: string, target: string) => ({
  source,
  target,
  sourceHandle: HANDLES.delegatesOut,
  targetHandle: HANDLES.delegationIn,
});

async function loadedStore(editable = true) {
  vi.mocked(api.fetchOrgGraph).mockResolvedValue({ graph: graph(), editable });
  vi.mocked(api.fetchOrg).mockResolvedValue({ leadAgentId: 'ceo', lead: null, leadCandidates: [] });
  const store = useOrgGraphStore();
  await store.load();
  return store;
}

describe('org graph store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.resetAllMocks();
  });
  afterEach(() => vi.useRealTimers());

  it('posts a valid connection and swaps the optimistic link for the saved one', async () => {
    const store = await loadedStore();
    let resolve: (link: api.AgentLink) => void = () => undefined;
    vi.mocked(api.createLink).mockReturnValue(new Promise((done) => (resolve = done)));
    const pending = store.connect(delegate('cto', 'dev'));
    expect(api.createLink).toHaveBeenCalledWith({ from: 'cto', to: 'dev', type: 'delegates' });
    expect(store.links.map((link) => link.id)).toEqual(['l1', 'pending-1']);
    resolve({ id: 'l2', from: 'cto', to: 'dev', type: 'delegates' });
    await expect(pending).resolves.toBe(true);
    expect(store.links.map((link) => link.id)).toEqual(['l1', 'l2']);
  });

  it.each(['reload', 'stream'] as const)(
    'retains a saved link after %s removes its optimistic entry',
    async (interleaving) => {
      const store = await loadedStore();
      const response = Promise.withResolvers<api.AgentLink>();
      vi.mocked(api.createLink).mockReturnValueOnce(response.promise);
      const pending = store.connect(delegate('cto', 'dev'));
      const saved: api.AgentLink = { id: 'l2', from: 'cto', to: 'dev', type: 'delegates' };
      if (interleaving === 'reload') await store.load();
      else store.applyEvent('agent_link', { ...saved });
      response.resolve(saved);
      await expect(pending).resolves.toBe(true);
      expect(store.links).toEqual([graph().links[0], saved]);
      expect(store.reachable.has('dev')).toBe(true);
    },
  );

  it('surfaces org failures while loading the graph', async () => {
    const store = await loadedStore();
    vi.mocked(api.fetchOrg).mockRejectedValueOnce(new ApiError('org unavailable', 500));
    await store.load();
    expect(store.loaded).toBe(true);
    expect(store.leadSupported).toBe(false);
    expect(store.leadCandidates).toEqual([]);
    expect(store.notice).toEqual({ text: 'org unavailable', color: 'error' });
  });

  it('reverts the optimistic link and shows the server message on 422', async () => {
    const store = await loadedStore();
    vi.mocked(api.createLink).mockRejectedValue(
      new ApiError('delegation cycle: dev -> cto -> dev', 422),
    );
    await expect(store.connect(delegate('cto', 'dev'))).resolves.toBe(false);
    expect(store.links.map((link) => link.id)).toEqual(['l1']);
    expect(store.notice).toEqual({ text: 'delegation cycle: dev -> cto -> dev', color: 'error' });
  });

  it('reports a duplicate on 409', async () => {
    const store = await loadedStore();
    vi.mocked(api.createLink).mockRejectedValue(new ApiError('conflict', 409));
    await store.connect(delegate('cto', 'dev'));
    expect(store.notice?.text).toBe('This link already exists.');
    expect(store.links).toHaveLength(1);
  });

  it('does not call the server for connections the rules reject or when read-only', async () => {
    const store = await loadedStore();
    await expect(store.connect(delegate('cto', 'ceo'))).resolves.toBe(false);
    expect(store.notice?.text).toBe('the lead does not receive delegation');
    const readOnly = await loadedStore(false);
    await expect(readOnly.connect(delegate('cto', 'dev'))).resolves.toBe(false);
    expect(api.createLink).not.toHaveBeenCalled();
  });

  it('deletes a link and restores it in place when the server refuses', async () => {
    const store = await loadedStore();
    vi.mocked(api.deleteLink).mockResolvedValueOnce(undefined);
    await expect(store.removeLink('l1')).resolves.toBe(true);
    expect(api.deleteLink).toHaveBeenCalledWith('l1');
    expect(store.links).toEqual([]);

    const again = await loadedStore();
    vi.mocked(api.deleteLink).mockRejectedValueOnce(new ApiError('nope', 500));
    await expect(again.removeLink('l1')).resolves.toBe(false);
    expect(again.links.map((link) => link.id)).toEqual(['l1']);
  });

  it('saves dragged positions once, debounced', async () => {
    const store = await loadedStore();
    vi.useFakeTimers();
    store.moveAgents({ cto: { x: 10, y: 20 } });
    store.moveAgents({ cto: { x: 15, y: 25 }, dev: { x: 1, y: 2 } });
    expect(store.agents['cto']?.position).toEqual({ x: 15, y: 25 });
    expect(api.saveLayout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LAYOUT_SAVE_DELAY_MS);
    expect(api.saveLayout).toHaveBeenCalledTimes(1);
    expect(api.saveLayout).toHaveBeenCalledWith([
      { agentId: 'cto', x: 15, y: 25 },
      { agentId: 'dev', x: 1, y: 2 },
    ]);
  });

  it('retains a failed batch for retry without overwriting newer positions', async () => {
    vi.useFakeTimers();
    const store = await loadedStore();
    const response = Promise.withResolvers<undefined>();
    vi.mocked(api.saveLayout).mockReturnValueOnce(response.promise);
    store.moveAgents({ cto: { x: 1, y: 2 }, dev: { x: 3, y: 4 } });
    const saving = store.flushLayout();
    store.moveAgents({ cto: { x: 5, y: 6 } });
    response.reject(new Error('save failed'));
    await expect(saving).resolves.toBe(false);
    expect(store.notice?.text).toBe('save failed');
    await expect(store.flushLayout()).resolves.toBe(true);
    expect(api.saveLayout).toHaveBeenLastCalledWith([
      { agentId: 'cto', x: 5, y: 6 },
      { agentId: 'dev', x: 3, y: 4 },
    ]);
  });

  it('waits for an active save and drains newer positions before fetching a reload', async () => {
    vi.useFakeTimers();
    const store = await loadedStore();
    const first = Promise.withResolvers<undefined>();
    const second = Promise.withResolvers<undefined>();
    vi.mocked(api.saveLayout)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    store.moveAgents({ cto: { x: 1, y: 2 } });
    const saving = store.flushLayout();
    store.moveAgents({ cto: { x: 5, y: 6 } });
    const reloading = store.load();
    expect(api.fetchOrgGraph).toHaveBeenCalledTimes(1);
    expect(api.saveLayout).toHaveBeenCalledTimes(1);
    first.resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.saveLayout).toHaveBeenCalledTimes(2);
    expect(api.saveLayout).toHaveBeenLastCalledWith([{ agentId: 'cto', x: 5, y: 6 }]);
    expect(api.fetchOrgGraph).toHaveBeenCalledTimes(1);
    second.resolve(undefined);
    await expect(saving).resolves.toBe(true);
    await reloading;
    expect(api.fetchOrgGraph).toHaveBeenCalledTimes(2);
  });

  it('rejects reload on save failure, preserves positions, and allows a later retry', async () => {
    vi.useFakeTimers();
    const store = await loadedStore();
    vi.mocked(api.saveLayout).mockRejectedValueOnce(new Error('save failed'));
    store.moveAgents({ cto: { x: 5, y: 6 } });
    await expect(store.load()).rejects.toThrow(
      'Could not save the current layout before reloading',
    );
    expect(api.fetchOrgGraph).toHaveBeenCalledTimes(1);
    expect(store.agents['cto']?.position).toEqual({ x: 5, y: 6 });
    await expect(store.flushLayout()).resolves.toBe(true);
    expect(api.saveLayout).toHaveBeenLastCalledWith([{ agentId: 'cto', x: 5, y: 6 }]);
  });

  it('does not discard unsaved positions when editing becomes unavailable', async () => {
    vi.useFakeTimers();
    const store = await loadedStore();
    store.moveAgents({ cto: { x: 5, y: 6 } });
    store.editable = false;
    await expect(store.load()).rejects.toThrow(
      'Could not save the current layout before reloading',
    );
    expect(api.fetchOrgGraph).toHaveBeenCalledTimes(1);
    expect(api.saveLayout).not.toHaveBeenCalled();
    store.editable = true;
    await expect(store.flushLayout()).resolves.toBe(true);
    expect(api.saveLayout).toHaveBeenLastCalledWith([{ agentId: 'cto', x: 5, y: 6 }]);
  });

  it('persists computed positions for agents that have none', async () => {
    vi.useFakeTimers();
    const unplaced = graph();
    unplaced.agents.push(agent('new', null));
    vi.mocked(api.fetchOrgGraph).mockResolvedValue({ graph: unplaced, editable: true });
    vi.mocked(api.fetchOrg).mockResolvedValue(null);
    const store = useOrgGraphStore();
    await store.load();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.saveLayout).toHaveBeenCalledWith([expect.objectContaining({ agentId: 'new' })]);
    expect(store.agents['new']?.position).not.toBeNull();
    expect(store.leadSupported).toBe(false);
    await expect(store.makeLead('cto')).resolves.toBe(false);
    expect(api.setLead).not.toHaveBeenCalled();
  });

  it('toggles wakeOnReport on a reports link and restores it when saving fails', async () => {
    const withReport = graph();
    withReport.links.push({ id: 'r1', from: 'cto', to: 'ceo', type: 'reports' });
    vi.mocked(api.fetchOrgGraph).mockResolvedValue({ graph: withReport, editable: true });
    vi.mocked(api.fetchOrg).mockResolvedValue(null);
    const store = useOrgGraphStore();
    await store.load();

    let resolve: (link: api.AgentLink) => void = () => undefined;
    vi.mocked(api.updateLink).mockReturnValueOnce(new Promise((done) => (resolve = done)));
    const saving = store.setWakeOnReport('r1', true);
    expect(store.links.find((link) => link.id === 'r1')?.wakeOnReport).toBe(true);
    resolve({ id: 'r1', from: 'cto', to: 'ceo', type: 'reports', wakeOnReport: true });
    await expect(saving).resolves.toBe(true);
    expect(api.updateLink).toHaveBeenCalledWith('r1', true);

    vi.mocked(api.updateLink).mockRejectedValueOnce(new ApiError('nope', 500));
    await expect(store.setWakeOnReport('r1', false)).resolves.toBe(false);
    expect(store.links.find((link) => link.id === 'r1')?.wakeOnReport).toBe(true);
    expect(store.notice?.color).toBe('error');

    await expect(store.setWakeOnReport('l1', true)).resolves.toBe(false);
    store.editable = false;
    await expect(store.setWakeOnReport('r1', false)).resolves.toBe(false);
    expect(api.updateLink).toHaveBeenCalledTimes(2);
  });

  it('makes a lead and reloads the graph', async () => {
    const store = await loadedStore();
    vi.mocked(api.setLead).mockResolvedValue(undefined);
    await expect(store.makeLead('cto')).resolves.toBe(true);
    expect(api.setLead).toHaveBeenCalledWith('cto');
    expect(api.fetchOrgGraph).toHaveBeenCalledTimes(2);
  });
});
