import type { CreateIssueInput, PlanningResult, Project } from '@conclavix/core';
import type { ClientSession } from 'mongodb';
import type { Database } from '../../db.js';
import type { IssueRepository } from '../issues/repository.js';
import { resolveLead } from './lead.js';

export const PLANNING_LABEL = 'planning';

/** The planning issue for a new project, assigned to the lead. */
export function planningIssue(project: Project, leadId: string): CreateIssueInput {
  const description = [
    `Plan the project ${project.name} (${project.key}).`,
    '',
    'Project description:',
    project.description.trim() || '(none given; ask the board with add_comment if it is unclear)',
    '',
    'As the lead:',
    '1. Read the project context (memory_search, get_project_board).',
    '2. Break the project into concrete issues with create_issue, one per deliverable,',
    '   each with a clear description and done criteria.',
    '3. Assign each issue to yourself or an agent you can delegate to (list_team), by role.',
    '4. Summarise the plan with add_comment on this issue, then set it to done.',
  ].join('\n');
  return {
    projectId: project.id,
    title: `Plan project ${project.name}`,
    description,
    status: 'todo',
    priority: 'medium',
    parentId: null,
    assigneeAgentId: leadId,
    blockedBy: [],
    labels: [PLANNING_LABEL],
  };
}

/** Creates the planning issue for new projects through the normal issue path, which wakes the lead. */
export class ProjectPlanner {
  constructor(
    private readonly database: Database,
    private readonly issues: IssueRepository,
  ) {}

  async plan(
    project: Project,
    autoPlan: boolean,
    session?: ClientSession,
  ): Promise<PlanningResult> {
    if (!autoPlan) {
      return { status: 'skipped', reason: 'disabled' };
    }
    const lead = await resolveLead(this.database);
    if (!lead) {
      return { status: 'skipped', reason: 'no_lead' };
    }
    const issue = await this.issues.create(
      planningIssue(project, lead._id.toHexString()),
      undefined,
      session,
    );
    return {
      status: 'created',
      issueId: issue.id,
      issueKey: issue.key,
      assigneeAgentId: lead._id.toHexString(),
    };
  }
}
