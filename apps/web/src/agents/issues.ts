import type { Issue } from '../api/types';

/** Statuses in which the API accepts a manual wake (mirrors the scheduler's actionable set). */
export const WAKEABLE_STATUSES = ['todo', 'in_progress'];

export const isWakeable = (issue: Pick<Issue, 'status'>): boolean =>
  WAKEABLE_STATUSES.includes(issue.status);

const OPEN_ORDER = ['in_progress', 'todo', 'in_review', 'backlog', 'done', 'cancelled'];

/** Work first: in progress, then todo, review, backlog, closed; newest first within a status. */
export function sortTasks(issues: Issue[]): Issue[] {
  const rank = (status: string): number => {
    const index = OPEN_ORDER.indexOf(status);
    return index === -1 ? OPEN_ORDER.length : index;
  };
  return [...issues].sort(
    (a, b) => rank(a.status) - rank(b.status) || (b.updatedAt > a.updatedAt ? 1 : -1),
  );
}
