import { describe, expect, it } from 'vitest';
import type { AgentLink } from '../src/api/org-graph';
import {
  HANDLES,
  checkConnection,
  linkTypeFor,
  reachableFromLead,
  type GraphView,
} from '../src/org/rules';

const link = (from: string, to: string, type: AgentLink['type'] = 'delegates'): AgentLink => ({
  id: `${type}:${from}:${to}`,
  from,
  to,
  type,
});

const delegate = (source: string, target: string) => ({
  source,
  target,
  sourceHandle: HANDLES.delegatesOut,
  targetHandle: HANDLES.delegationIn,
});
const report = (source: string, target: string) => ({
  source,
  target,
  sourceHandle: HANDLES.reportsOut,
  targetHandle: HANDLES.reportsIn,
});

const graph: GraphView = {
  leadAgentId: 'ceo',
  links: [link('ceo', 'cto'), link('cto', 'dev'), link('dev', 'cto', 'reports')],
};

describe('connection rules', () => {
  it('maps handle pairs to link types and rejects mixed pairs', () => {
    expect(linkTypeFor(HANDLES.delegatesOut, HANDLES.delegationIn)).toBe('delegates');
    expect(linkTypeFor(HANDLES.reportsOut, HANDLES.reportsIn)).toBe('reports');
    expect(linkTypeFor(HANDLES.delegatesOut, HANDLES.reportsIn)).toBeNull();
    expect(linkTypeFor(HANDLES.reportsOut, HANDLES.delegationIn)).toBeNull();
    expect(
      checkConnection(graph, { ...delegate('ceo', 'qa'), targetHandle: HANDLES.reportsIn }).ok,
    ).toBe(false);
  });

  it('accepts a second delegator and several report targets for one agent', () => {
    expect(checkConnection(graph, delegate('ceo', 'dev'))).toEqual({
      ok: true,
      link: { from: 'ceo', to: 'dev', type: 'delegates' },
    });
    expect(checkConnection(graph, report('dev', 'ceo')).ok).toBe(true);
  });

  it('rejects self links, duplicates and delegation into the lead', () => {
    expect(checkConnection(graph, report('dev', 'dev'))).toMatchObject({ ok: false });
    expect(checkConnection(graph, delegate('cto', 'dev'))).toMatchObject({
      ok: false,
      reason: 'this link already exists',
    });
    expect(checkConnection(graph, delegate('dev', 'ceo'))).toMatchObject({
      ok: false,
      reason: 'the lead does not receive delegation',
    });
  });

  it('rejects delegation cycles but allows report cycles', () => {
    const noLead = { ...graph, leadAgentId: null };
    expect(checkConnection(noLead, delegate('dev', 'ceo'))).toMatchObject({
      ok: false,
      reason: 'delegation would form a cycle',
    });
    expect(checkConnection(graph, report('cto', 'dev')).ok).toBe(true);
  });

  it('finds agents reachable from the lead through delegation only', () => {
    const reached = reachableFromLead({
      leadAgentId: 'ceo',
      links: [...graph.links, link('qa', 'ceo', 'reports')],
    });
    expect([...reached].sort()).toEqual(['ceo', 'cto', 'dev']);
    expect(reachableFromLead({ leadAgentId: null, links: graph.links }).size).toBe(0);
  });
});
