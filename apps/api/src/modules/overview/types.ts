import { z } from 'zod';

export const overviewQuerySchema = z.strictObject({
  days: z.coerce.number().int().min(1).max(60).default(14),
});

export type OverviewQuery = z.infer<typeof overviewQuerySchema>;

export interface DayBucket {
  date: string;
  runs: number;
  failed: number;
  costUsd: number;
}

export interface AgentToday {
  agentId: string;
  name: string;
  runs: number;
  failed: number;
  costUsd: number;
}

export interface PausedAgent {
  agentId: string;
  name: string;
  reason: 'loop' | 'manual';
  since: Date;
  issueId: string | null;
  issueKey: string | null;
}

export interface BudgetHeldAgent {
  agentId: string;
  name: string;
  costTodayUsd: number;
  limitUsd: number;
}

export interface FailedRun {
  runId: string;
  agentId: string;
  agentName: string;
  /** Null for chat runs. */
  issueId: string | null;
  chatId: string | null;
  issueKey: string | null;
  status: string;
  error: string | null;
  finishedAt: Date | null;
}

export interface IssueRef {
  issueId: string;
  key: string;
  title: string;
  assigneeAgentId: string | null;
  updatedAt: Date;
}

export interface BlockedIssue extends IssueRef {
  blockers: { issueId: string; key: string; status: string }[];
}

export interface ActivityItem {
  kind: 'run_finished' | 'run_failed' | 'comment' | 'issue_closed' | 'issue_created';
  at: Date;
  issueId: string | null;
  issueKey: string | null;
  runId: string | null;
  agentId: string | null;
  text: string;
}

export interface Overview {
  generatedAt: Date;
  timezone: 'UTC';
  days: number;
  kpis: {
    runsToday: number;
    failedToday: number;
    costTodayUsd: number;
    dailyBudgetUsd: number;
    issuesDoneToday: number;
    issuesDone7d: number;
    activeAgents: number;
    totalAgents: number;
    pendingWakes: number;
  };
  costPerDay: DayBucket[];
  runsPerAgentToday: AgentToday[];
  issuesByStatus: Record<string, number>;
  attention: {
    pausedAgents: PausedAgent[];
    budgetHeld: BudgetHeldAgent[];
    failedRuns: FailedRun[];
    failedRuns24h: number;
    blockedIssues: BlockedIssue[];
    inReview: IssueRef[];
  };
  activity: ActivityItem[];
}
