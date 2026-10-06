import type { Collections } from '../../db.js';

export interface IdleLimitMigration {
  agents: number;
  wakes: number;
}

/**
 * Move `limits.maxRunsPerIssuePerHour` to `limits.maxIdleRunsPerIssue`, keeping its value (an
 * agent that already has the new field keeps that one), and release wakes still deferred by the
 * former hourly run window, which no longer exists. Idempotent, so it runs on every start.
 */
export async function migrateIdleRunLimit(collections: Collections): Promise<IdleLimitMigration> {
  const agents = await collections.agents.updateMany(
    { 'limits.maxRunsPerIssuePerHour': { $exists: true } },
    [
      {
        $set: {
          'limits.maxIdleRunsPerIssue': {
            $ifNull: ['$limits.maxIdleRunsPerIssue', '$limits.maxRunsPerIssuePerHour'],
          },
        },
      },
      { $unset: 'limits.maxRunsPerIssuePerHour' },
    ],
  );
  const wakes = await collections.wakes.updateMany(
    { processedAt: null, deferReason: 'run_rate_limit' },
    { $set: { notBefore: null, deferReason: null } },
  );
  return { agents: agents.modifiedCount, wakes: wakes.modifiedCount };
}
