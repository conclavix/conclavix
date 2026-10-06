import { describe, expect, it } from 'vitest';
import type { Overview } from '../src/api/overview';
import { statusItems, statusSummary } from '../src/overview/status';

const overview = (attention: Partial<Overview['attention']>, costTodayUsd = 0): Overview =>
  ({
    kpis: { costTodayUsd },
    attention: {
      pausedAgents: [],
      budgetHeld: [],
      failedRuns: [],
      failedRuns24h: 0,
      blockedIssues: [],
      inReview: [],
      ...attention,
    },
  }) as unknown as Overview;

describe('header status items', () => {
  it('renders nothing when nothing is on', () => {
    const items = statusItems({ running: 0, queued: 0, pausedAgents: 0, overview: overview({}) });
    expect(items).toEqual([]);
    expect(statusSummary(items)).toBeNull();
  });

  it('shows only the items that are on, attention last with state colours', () => {
    const items = statusItems({
      running: 2,
      queued: 0,
      pausedAgents: 1,
      overview: overview({ failedRuns24h: 3 }, 1.5),
    });
    expect(items.map((item) => [item.id, item.value, item.color])).toEqual([
      ['running', '2', undefined],
      ['cost', '$1.50', undefined],
      ['paused', '1', 'warning'],
      ['failed', '3', 'error'],
    ]);
  });

  it('summarises attention for the collapsed header', () => {
    const items = statusItems({
      running: 1,
      queued: 0,
      pausedAgents: 1,
      overview: overview({ failedRuns24h: 2 }),
    });
    expect(statusSummary(items)).toMatchObject({ label: 'Attention', value: '3', color: 'error' });
    const calm = statusItems({ running: 1, queued: 0, pausedAgents: 0, overview: null });
    expect(statusSummary(calm)).toMatchObject({ id: 'running', value: '1' });
  });
});
