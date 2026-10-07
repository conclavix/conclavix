import { z } from 'zod';
import { idSchema } from './ids.js';

export const wakeReasonSchema = z.enum([
  'assigned',
  'comment',
  'unblocked',
  'heartbeat',
  'manual',
  'delegation_closed',
  'report_closed',
]);

export const runStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);

export const FINISHED_RUN_STATUSES = ['succeeded', 'failed', 'cancelled', 'timed_out'] as const;

export const manualWakeSchema = z.strictObject({ issueId: idSchema });

export const listRunsQuerySchema = z.strictObject({
  agentId: idSchema.optional(),
  issueId: idSchema.optional(),
  status: z
    .string()
    .transform((value) => value.split(','))
    .pipe(z.array(runStatusSchema))
    .optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: idSchema.optional(),
});

export type WakeReason = z.infer<typeof wakeReasonSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type FinishedRunStatus = (typeof FINISHED_RUN_STATUSES)[number];
export type ListRunsQuery = z.infer<typeof listRunsQuerySchema>;

/**
 * What a coding agent's run left in the issue's clone: the runner's commit on the issue branch,
 * the diff stats against the branch tip before the run, and whether the branch reached the
 * project repository.
 */
export interface RunCode {
  branch: string;
  /** Tip of the issue branch in the project repository when the run started. */
  base: string | null;
  /** Tip of the issue branch in the clone after the runner's commit. */
  head: string | null;
  /** The runner's commit, or null when the work tree had no changes. */
  commit: string | null;
  /** Commits the agent made itself during the run. */
  agentCommits: number;
  files: number;
  insertions: number;
  deletions: number;
  /** True when the branch was fetched into the project repository. */
  synced: boolean;
  /** Why committing or syncing failed; redacted like the run log. */
  error: string | null;
}

export interface Run {
  id: string;
  agentId: string;
  issueId: string;
  reason: WakeReason;
  status: RunStatus;
  costUsd: number;
  maxCostPerRunUsd: number;
  overBudget: boolean;
  madeProgress: boolean | null;
  error: string | null;
  /** Set for runs of agents with code access 'write'. */
  code: RunCode | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export type WakeSkipReason =
  | 'agent_missing'
  | 'agent_paused'
  | 'issue_missing'
  | 'issue_closed'
  | 'not_assigned'
  | 'blocked'
  | 'run_rate_limit'
  | 'idle_backoff'
  | 'issue_run_cap'
  | 'daily_cost_limit'
  | 'agent_disabled_in_project';

/**
 * Limits whose window frees on its own: such a wake stays pending until `notBefore`
 * instead of being skipped. Wakes processed before deferral existed may carry them as skipReason.
 * `run_rate_limit` is the former hourly run window; it is no longer produced, only kept on
 * stored wakes.
 */
export type WakeDeferReason = Extract<
  WakeSkipReason,
  'run_rate_limit' | 'idle_backoff' | 'issue_run_cap' | 'daily_cost_limit'
>;
