import type { AgentNotification, AgentSummary } from '@conclavix/core';
import type { ObjectId } from 'mongodb';
import type { AgentDoc, Database } from '../../db.js';
import { projectAccessChecker } from '../projects/agent-access.js';
import { isLead } from './lead.js';
import { linkedAgents } from './links.js';
import { listNotifications } from './notifications.js';
import { toAgentSummary } from './repository.js';

export const PROMPT_NOTIFICATIONS = 5;

/** Where an agent sits in the agent graph, for its run prompt. */
export interface OrgPosition {
  isLead: boolean;
  delegators: AgentSummary[];
  delegates: AgentSummary[];
  /** Linked agents not enabled in the project of the run's issue. */
  delegatesNotInProject: AgentSummary[];
  reportsTo: AgentSummary[];
  notifications: AgentNotification[];
}

/**
 * Read an agent's links and its newest unread notifications. With a project, delegates not
 * enabled there are split off so the prompt does not offer them.
 */
export async function loadPosition(
  database: Database,
  agent: AgentDoc,
  projectId?: ObjectId,
): Promise<OrgPosition> {
  const { collections } = database;
  const [lead, delegators, delegates, reportsTo, notifications, access] = await Promise.all([
    isLead(database, agent._id),
    linkedAgents(collections, agent._id, 'delegates', 'incoming'),
    linkedAgents(collections, agent._id, 'delegates', 'outgoing'),
    linkedAgents(collections, agent._id, 'reports', 'outgoing'),
    listNotifications(collections, agent._id, { unreadOnly: true, limit: PROMPT_NOTIFICATIONS }),
    projectId ? projectAccessChecker(collections, projectId) : null,
  ]);
  const enabled = (doc: AgentDoc) => access?.isEnabled(doc) ?? true;
  return {
    isLead: lead,
    delegators: delegators.map(toAgentSummary),
    delegates: delegates.filter(enabled).map(toAgentSummary),
    delegatesNotInProject: delegates.filter((doc) => !enabled(doc)).map(toAgentSummary),
    reportsTo: reportsTo.map(toAgentSummary),
    notifications,
  };
}
