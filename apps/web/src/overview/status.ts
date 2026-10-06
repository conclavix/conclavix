import type { RouteLocationRaw } from 'vue-router';
import type { Overview } from '../api/overview';
import { usd } from '../format';

export interface StatusItem {
  id: string;
  label: string;
  value: string;
  color?: 'error' | 'warning';
  attention: boolean;
  to: RouteLocationRaw;
}

export interface StatusInput {
  running: number;
  queued: number;
  pausedAgents: number;
  overview: Overview | null;
}

const OVERVIEW: RouteLocationRaw = { name: 'overview', hash: '#kpis' };
const ATTENTION: RouteLocationRaw = { name: 'overview', hash: '#attention' };
const LIVE: RouteLocationRaw = { name: 'live' };

interface Candidate {
  id: string;
  label: string;
  count: number;
  value?: string;
  color?: StatusItem['color'];
  to: RouteLocationRaw;
}

/** Header status items; only items that are on are returned, attention items last. */
export function statusItems(input: StatusInput): StatusItem[] {
  const cost = input.overview?.kpis.costTodayUsd ?? 0;
  const attention = input.overview?.attention;
  const base: Candidate[] = [
    { id: 'running', label: 'Running', count: input.running, to: LIVE },
    { id: 'queued', label: 'Queued', count: input.queued, to: LIVE },
    { id: 'cost', label: 'Today (UTC)', count: cost, value: usd(cost), to: OVERVIEW },
  ];
  const flagged: Candidate[] = [
    { id: 'paused', label: 'Paused', count: input.pausedAgents },
    { id: 'budget', label: 'Budget reached', count: attention?.budgetHeld.length ?? 0 },
    {
      id: 'failed',
      label: 'Failed 24h',
      count: attention?.failedRuns24h ?? 0,
      color: 'error' as const,
    },
    { id: 'blocked', label: 'Blocked', count: attention?.blockedIssues.length ?? 0 },
  ].map((item): Candidate => ({ color: 'warning', ...item, to: ATTENTION }));
  const toItem = (item: Candidate, isAttention: boolean): StatusItem => ({
    id: item.id,
    label: item.label,
    value: item.value ?? String(item.count),
    ...(item.color ? { color: item.color } : {}),
    attention: isAttention,
    to: item.to,
  });
  return [
    ...base.filter((item) => item.count > 0).map((item) => toItem(item, false)),
    ...flagged.filter((item) => item.count > 0).map((item) => toItem(item, true)),
  ];
}

/** One-line summary for the collapsed header, or null when nothing is on. */
export function statusSummary(items: StatusItem[]): StatusItem | null {
  const attention = items.filter((item) => item.attention);
  if (attention.length > 0) {
    const count = attention.reduce((sum, item) => sum + Number(item.value), 0);
    const color = attention.some((item) => item.color === 'error') ? 'error' : 'warning';
    return {
      id: 'summary',
      label: 'Attention',
      value: String(count),
      color,
      attention: true,
      to: ATTENTION,
    };
  }
  const running = items.find((item) => item.id === 'running');
  return running ?? items[0] ?? null;
}
