import type { Collections } from '../../db.js';
import { costPerDay, issuesByStatus, issuesDone, runsPerAgentToday } from './aggregates.js';
import { recentActivity } from './activity.js';
import { blockedIssues, budgetHeld, failedRuns, inReview, pausedAgents } from './attention.js';
import type { Overview, OverviewQuery } from './types.js';

const ACTIVITY_LIMIT = 25;

/** Aggregated board overview; days are bucketed in UTC like the scheduler's daily cost limit. */
export class OverviewService {
  constructor(
    private readonly collections: Collections,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async get(query: OverviewQuery): Promise<Overview> {
    const now = this.clock();
    const { collections } = this;
    const agentDocs = await collections.agents.find().sort({ name: 1 }).toArray();
    const agents = new Map(agentDocs.map((agent) => [agent._id.toHexString(), agent]));
    const [perDay, perAgent, statuses, done, paused, failed, blocked, review, activity, wakes] =
      await Promise.all([
        costPerDay(collections, now, query.days),
        runsPerAgentToday(collections, agents, now),
        issuesByStatus(collections),
        issuesDone(collections, now),
        pausedAgents(collections, agentDocs),
        failedRuns(collections, agents, now),
        blockedIssues(collections),
        inReview(collections),
        recentActivity(collections, agents, ACTIVITY_LIMIT),
        collections.wakes.countDocuments({ processedAt: null }),
      ]);
    const today = perDay.at(-1);
    const active = agentDocs.filter((agent) => agent.status === 'active');
    return {
      generatedAt: now,
      timezone: 'UTC',
      days: query.days,
      kpis: {
        runsToday: today?.runs ?? 0,
        failedToday: today?.failed ?? 0,
        costTodayUsd: today?.costUsd ?? 0,
        dailyBudgetUsd: active.reduce((sum, agent) => sum + agent.limits.maxCostPerDayUsd, 0),
        issuesDoneToday: done.today,
        issuesDone7d: done.week,
        activeAgents: active.length,
        totalAgents: agentDocs.length,
        pendingWakes: wakes,
      },
      costPerDay: perDay,
      runsPerAgentToday: perAgent,
      issuesByStatus: statuses,
      attention: {
        pausedAgents: paused,
        budgetHeld: budgetHeld(agentDocs, perAgent),
        failedRuns: failed.items,
        failedRuns24h: failed.total,
        blockedIssues: blocked,
        inReview: review,
      },
      activity,
    };
  }
}
