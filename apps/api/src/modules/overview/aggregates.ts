import type { ObjectId } from 'mongodb';
import type { AgentDoc, Collections } from '../../db.js';
import { DAY_MS, startOfUtcDay, utcDate } from './time.js';
import type { AgentToday, DayBucket } from './types.js';

const FAILED = ['failed', 'timed_out'];

/** Drop floating point noise from summed costs. */
export const roundUsd = (value: number): number => Math.round(value * 1e6) / 1e6;

interface Bucket<K> {
  _id: K;
  runs: number;
  failed: number;
  costUsd: number;
}

const bucketFields = {
  runs: { $sum: 1 },
  failed: { $sum: { $cond: [{ $in: ['$status', FAILED] }, 1, 0] } },
  costUsd: { $sum: '$costUsd' },
};

/** Runs, failures and cost per UTC day for the last `days` days, today last, gaps filled. */
export async function costPerDay(
  collections: Collections,
  now: Date,
  days: number,
): Promise<DayBucket[]> {
  const from = new Date(startOfUtcDay(now).getTime() - (days - 1) * DAY_MS);
  const rows = await collections.runs
    .aggregate<Bucket<string>>([
      { $match: { createdAt: { $gte: from } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
          ...bucketFields,
        },
      },
    ])
    .toArray();
  const byDate = new Map(rows.map((row) => [row._id, row]));
  return Array.from({ length: days }, (_, index) => {
    const date = utcDate(new Date(from.getTime() + index * DAY_MS));
    const row = byDate.get(date);
    return {
      date,
      runs: row?.runs ?? 0,
      failed: row?.failed ?? 0,
      costUsd: roundUsd(row?.costUsd ?? 0),
    };
  });
}

/** Runs, failures and cost per agent since UTC midnight, busiest first. */
export async function runsPerAgentToday(
  collections: Collections,
  agents: Map<string, AgentDoc>,
  now: Date,
): Promise<AgentToday[]> {
  const rows = await collections.runs
    .aggregate<Bucket<ObjectId>>([
      { $match: { createdAt: { $gte: startOfUtcDay(now) } } },
      { $group: { _id: '$agentId', ...bucketFields } },
    ])
    .toArray();
  return rows
    .map((row) => {
      const agentId = row._id.toHexString();
      return {
        agentId,
        name: agents.get(agentId)?.name ?? 'deleted agent',
        runs: row.runs,
        failed: row.failed,
        costUsd: roundUsd(row.costUsd),
      };
    })
    .sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name));
}

/** Number of issues in each status. */
export async function issuesByStatus(collections: Collections): Promise<Record<string, number>> {
  const rows = await collections.issues
    .aggregate<{ _id: string; count: number }>([{ $group: { _id: '$status', count: { $sum: 1 } } }])
    .toArray();
  return Object.fromEntries(rows.map((row) => [row._id, row.count]));
}

/** Issues closed as done since UTC midnight and within the last seven UTC days. */
export async function issuesDone(
  collections: Collections,
  now: Date,
): Promise<{ today: number; week: number }> {
  const today = startOfUtcDay(now);
  const weekStart = new Date(today.getTime() - 6 * DAY_MS);
  const [row] = await collections.issues
    .aggregate<{ today: number; week: number }>([
      { $match: { status: 'done', closedAt: { $gte: weekStart } } },
      {
        $group: {
          _id: null,
          week: { $sum: 1 },
          today: { $sum: { $cond: [{ $gte: ['$closedAt', today] }, 1, 0] } },
        },
      },
    ])
    .toArray();
  return { today: row?.today ?? 0, week: row?.week ?? 0 };
}
