import { describe, expect, it } from 'vitest';
import type { AgentLink, GraphAgent, Position } from '../src/api/org-graph';
import { NODE_HEIGHT, NODE_WIDTH, autoArrange, placeMissing } from '../src/org/layout';

const agent = (id: string, position: Position | null = null): GraphAgent => ({
  id,
  name: id,
  role: '',
  title: '',
  status: 'active',
  model: null,
  position,
});
const delegates = (from: string, to: string): AgentLink => ({
  id: `${from}${to}`,
  from,
  to,
  type: 'delegates',
});
const reports = (from: string, to: string): AgentLink => ({
  id: `r${from}${to}`,
  from,
  to,
  type: 'reports',
});

const overlaps = (a: Position, b: Position): boolean =>
  Math.abs(a.x - b.x) < NODE_WIDTH && Math.abs(a.y - b.y) < NODE_HEIGHT;

function assertNoOverlap(positions: Record<string, Position>): void {
  const list = Object.values(positions);
  list.forEach((a, i) => list.slice(i + 1).forEach((b) => expect(overlaps(a, b)).toBe(false)));
}

describe('auto-arrange', () => {
  const agents = ['ceo', 'a', 'b', 'c', 'a1', 'a2', 'a3', 'b1', 'loner'].map((id) => agent(id));
  const links = [
    delegates('ceo', 'a'),
    delegates('ceo', 'b'),
    delegates('ceo', 'c'),
    delegates('a', 'a1'),
    delegates('a', 'a2'),
    delegates('a', 'a3'),
    delegates('b', 'b1'),
    delegates('c', 'b1'),
    reports('a1', 'ceo'),
    reports('ceo', 'a1'),
  ];

  it('ranks delegation left to right and ignores report cycles', () => {
    const positions = autoArrange(agents, links);
    const x = (id: string): number => positions[id]?.x ?? NaN;
    expect(x('ceo')).toBeLessThan(x('a'));
    expect(x('a')).toBeLessThan(x('a1'));
    expect(x('b')).toBeLessThan(x('b1'));
    expect(Object.keys(positions).sort()).toEqual(agents.map((item) => item.id).sort());
    assertNoOverlap(positions);
  });

  it('places only unplaced agents, below the placed ones', () => {
    const placed = [agent('ceo', { x: 0, y: 0 }), agent('a', { x: 400, y: 300 })];
    const fresh = [agent('x'), agent('y')];
    const result = placeMissing([...placed, ...fresh], [delegates('x', 'y')]);
    expect(Object.keys(result).sort()).toEqual(['x', 'y']);
    for (const point of Object.values(result)) {
      expect(point.y).toBeGreaterThanOrEqual(300 + NODE_HEIGHT);
    }
    assertNoOverlap({ ...result, ceo: { x: 0, y: 0 }, a: { x: 400, y: 300 } });
  });

  it('lays out everything when nothing is placed and nothing when all are', () => {
    expect(Object.keys(placeMissing(agents, links))).toHaveLength(agents.length);
    expect(placeMissing([agent('a', { x: 1, y: 2 })], [])).toEqual({});
  });
});
