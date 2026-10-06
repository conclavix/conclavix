import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tokenStore } from '../src/api/client';
import {
  createLink,
  deleteLink,
  deriveGraph,
  fetchOrg,
  fetchOrgGraph,
  saveLayout,
  updateLink,
} from '../src/api/org-graph';
import { toEdges } from '../src/org/nodes';
import type { OrgNode } from '../src/api/types';

const node = (id: string, reports: OrgNode[] = []): OrgNode => ({
  id,
  name: id.toUpperCase(),
  role: 'r',
  title: '',
  status: 'active',
  avatarUrl: null,
  reports,
});

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('deriveGraph', () => {
  it('turns each reporting line into a delegation down and a report up', () => {
    const graph = deriveGraph([node('ceo', [node('cto', [node('dev')]), node('cfo')])]);
    expect(graph.leadAgentId).toBe('ceo');
    expect(graph.agents.map((agent) => agent.id)).toEqual(['ceo', 'cto', 'dev', 'cfo']);
    expect(graph.agents.every((agent) => agent.position === null)).toBe(true);
    const pairs = graph.links.map((link) => `${link.type}:${link.from}>${link.to}`);
    expect(pairs).toEqual([
      'delegates:ceo>cto',
      'reports:cto>ceo',
      'delegates:cto>dev',
      'reports:dev>cto',
      'delegates:ceo>cfo',
      'reports:cfo>ceo',
    ]);
    expect(new Set(graph.links.map((link) => link.id)).size).toBe(graph.links.length);
  });

  it('has no lead when the forest has several roots', () => {
    const graph = deriveGraph([node('a'), node('b')]);
    expect(graph.leadAgentId).toBeNull();
    expect(graph.links).toEqual([]);
  });
});

describe('fetchOrgGraph', () => {
  beforeEach(() => tokenStore.set('t'.repeat(32)));
  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStore.clear();
  });

  it('uses /org-graph and marks it editable', async () => {
    const graph = { leadAgentId: 'a', agents: [], links: [] };
    const fetchMock = vi.fn(async () => json(200, graph));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchOrgGraph()).resolves.toEqual({ graph, editable: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/org-graph', expect.anything());
  });

  it('falls back to the legacy chart read-only on 404', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === '/api/org-graph'
        ? json(404, { message: 'not found' })
        : json(200, { roots: [node('a', [node('b')])] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const loaded = await fetchOrgGraph();
    expect(loaded.editable).toBe(false);
    expect(loaded.graph.leadAgentId).toBe('a');
    expect(loaded.graph.links).toHaveLength(2);
  });

  it('propagates other errors instead of falling back', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(500, { message: 'boom' })),
    );
    await expect(fetchOrgGraph()).rejects.toThrow('boom');
  });

  it.each([
    { leadAgentId: null, links: [] },
    { leadAgentId: null, agents: [], links: [{ id: 'l', from: 'a', to: 'b', type: 'unknown' }] },
    {
      leadAgentId: null,
      agents: [{ ...node('a'), model: null, position: { x: 'bad', y: 0 } }],
      links: [],
    },
  ])('rejects malformed graph data without using the fallback: %j', async (body) => {
    const fetchMock = vi.fn(async () => json(200, body));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchOrgGraph()).rejects.toThrow('Invalid response from /org-graph');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { roots: [node('a', [{ ...node('b'), status: 'broken' } as unknown as OrgNode])] }])(
    'validates the legacy chart recursively: %j',
    async (body) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => (url === '/api/org-graph' ? json(404, {}) : json(200, body))),
      );
      await expect(fetchOrgGraph()).rejects.toThrow('Invalid response from /org-chart');
    },
  );

  it('validates graph agents and preserves nullable positions', async () => {
    const graph = deriveGraph([node('a')]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(200, graph)),
    );
    await expect(fetchOrgGraph()).resolves.toEqual({ graph, editable: true });
  });

  it.each([
    { leadAgentId: null, lead: null },
    { leadAgentId: null, lead: null, leadCandidates: [{}] },
    { leadAgentId: null, lead: { id: 'a' }, leadCandidates: [] },
  ])('rejects malformed org settings: %j', async (body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(200, body)),
    );
    await expect(fetchOrg()).rejects.toThrow('Invalid response from /org');
  });

  it('validates created links and preserves contextual errors', async () => {
    const link = { from: 'a', to: 'b', type: 'delegates' as const };
    const fetchMock = vi.fn(async () => json(200, { id: 'l', ...link }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(createLink(link)).resolves.toEqual({ id: 'l', ...link });
    fetchMock.mockResolvedValueOnce(json(200, { ...link }));
    await expect(createLink(link)).rejects.toThrow('Invalid response from /agent-links');
    fetchMock.mockResolvedValueOnce(json(200, { id: 'l', ...link, type: 'unknown' }));
    await expect(createLink(link)).rejects.toThrow('Invalid response from /agent-links');
    fetchMock.mockResolvedValueOnce(json(500, { message: 'org unavailable' }));
    await expect(fetchOrg()).rejects.toThrow('org unavailable');
  });

  it('patches wakeOnReport on a link and validates the saved link', async () => {
    const saved = { id: 'r/1', from: 'a', to: 'b', type: 'reports', wakeOnReport: true };
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      json(200, saved),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(updateLink('r/1', true)).resolves.toEqual(saved);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toMatch(/\/agent-links\/r%2F1$/);
    expect(init).toMatchObject({ method: 'PATCH', body: JSON.stringify({ wakeOnReport: true }) });
    fetchMock.mockResolvedValueOnce(json(200, { ...saved, wakeOnReport: 'yes' }));
    await expect(updateLink('r/1', true)).rejects.toThrow('Invalid response from /agent-links');
    fetchMock.mockResolvedValueOnce(json(422, { message: 'reports links only' }));
    await expect(updateLink('r/1', true)).rejects.toThrow('reports links only');
  });

  it('marks reports edges that wake their target', () => {
    const colors = { delegates: 'blue', reports: 'green' };
    const edges = toEdges(
      [
        { id: 'd', from: 'a', to: 'b', type: 'delegates' },
        { id: 'r', from: 'b', to: 'a', type: 'reports', wakeOnReport: true },
        { id: 'q', from: 'c', to: 'a', type: 'reports', wakeOnReport: false },
      ],
      true,
      colors,
    );
    expect(edges.map((edge) => edge.class)).toEqual([
      'edge-delegates',
      'edge-reports edge-wakes',
      'edge-reports',
    ]);
  });

  it('reads /org and returns null when the lead API is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(404, {})),
    );
    await expect(fetchOrg()).resolves.toBeNull();
    const org = { leadAgentId: null, lead: null, leadCandidates: [], updatedAt: null };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(200, org)),
    );
    await expect(fetchOrg()).resolves.toEqual(org);
  });

  it('treats deleting a link that is already gone as success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(404, { message: 'link not found' })),
    );
    await expect(deleteLink('l1')).resolves.toBeUndefined();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(500, { message: 'boom' })),
    );
    await expect(deleteLink('l1')).rejects.toThrow('boom');
  });

  it('clamps layout coordinates and splits large saves into batches of 500', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response(null, { status: 204 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const positions = Array.from({ length: 501 }, (_, i) => ({
      agentId: `a${i}`,
      x: i + 0.4,
      y: 0,
    }));
    positions[0] = { agentId: 'a0', x: 5e6, y: -5e6 };
    await saveLayout(positions);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      positions: { agentId: string; x: number; y: number }[];
    };
    expect(first.positions).toHaveLength(500);
    expect(first.positions[0]).toEqual({ agentId: 'a0', x: 1_000_000, y: -1_000_000 });
    expect(first.positions[1]).toEqual({ agentId: 'a1', x: 1, y: 0 });
    const second = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(second.positions).toEqual([{ agentId: 'a500', x: 500, y: 0 }]);
  });
});
