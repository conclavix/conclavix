import { ApiError } from './api/client';
import type { IssueDetail } from './api/types';

export interface BoardColumn {
  id: string;
  title: string;
  status: string;
}

/** Default board columns in display order; projects will later supply their own list. */
export const BOARD_COLUMNS: readonly BoardColumn[] = [
  { id: 'backlog', title: 'Backlog', status: 'backlog' },
  { id: 'todo', title: 'To do', status: 'todo' },
  { id: 'in_progress', title: 'In progress', status: 'in_progress' },
  { id: 'in_review', title: 'In review', status: 'in_review' },
  { id: 'done', title: 'Done', status: 'done' },
  { id: 'cancelled', title: 'Cancelled', status: 'cancelled' },
];

/** Column for an issue: its explicit column if the board has it, else the first column of its status. */
export function columnFor(
  issue: { status?: string; columnId?: string | null },
  columns: readonly BoardColumn[],
): BoardColumn | undefined {
  return (
    columns.find((column) => issue.columnId != null && column.id === issue.columnId) ??
    columns.find((column) => column.status === (issue.status ?? 'todo'))
  );
}

/** Group issues by column id, newest first; issues whose status has no column are left out. */
export function groupByColumn<T extends { id: string; status?: string; columnId?: string | null }>(
  issues: readonly T[],
  columns: readonly BoardColumn[],
): Record<string, T[]> {
  const groups: Record<string, T[]> = Object.fromEntries(columns.map((c) => [c.id, [] as T[]]));
  for (const issue of issues) {
    const column = columnFor(issue, columns);
    if (column) groups[column.id]?.push(issue);
  }
  for (const list of Object.values(groups)) {
    list.sort((a, b) => (b.id > a.id ? 1 : b.id < a.id ? -1 : 0));
  }
  return groups;
}

export const STATUS_TITLES: Readonly<Record<string, string>> = Object.fromEntries(
  BOARD_COLUMNS.map((column) => [column.status, column.title]),
);

/** Human title for an issue status, falling back to the raw value for unknown ones. */
export const statusTitle = (status: string | undefined): string =>
  (status && STATUS_TITLES[status]) || status || '';

export const PRIORITIES: readonly string[] = ['low', 'medium', 'high', 'urgent'];

/** Theme colour names, so priorities follow the active theme; unknown priorities stay neutral. */
export const PRIORITY_COLORS: Readonly<Record<string, string | undefined>> = {
  low: 'secondary',
  medium: 'info',
  high: 'warning',
  urgent: 'error',
};

export interface IssueForm {
  title: string;
  description: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  parentId: string | null;
  blockedBy: string[];
  labels: string[];
}

/** Copy the editable fields of an issue into a fresh form object. */
export function toIssueForm(issue: IssueDetail): IssueForm {
  return {
    title: issue.title,
    description: issue.description,
    status: issue.status,
    priority: issue.priority,
    assigneeAgentId: issue.assigneeAgentId,
    parentId: issue.parentId,
    blockedBy: [...issue.blockedBy],
    labels: [...issue.labels],
  };
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/** Normalise label input: trimmed, non-empty, unique, in entry order. */
export const cleanLabels = (labels: readonly string[]): string[] => [
  ...new Set(labels.map((label) => label.trim()).filter(Boolean)),
];

/** Only the fields that differ from the issue, so a PATCH never rewrites untouched fields. */
export function issuePatch(issue: IssueDetail, form: IssueForm): Partial<IssueForm> {
  const patch: Partial<IssueForm> = {};
  const scalars = [
    'title',
    'description',
    'status',
    'priority',
    'assigneeAgentId',
    'parentId',
  ] as const;
  for (const field of scalars) {
    const value = field === 'title' ? form.title.trim() : form[field];
    if (value !== issue[field]) {
      Object.assign(patch, { [field]: value });
    }
  }
  if (!sameSet(form.blockedBy, issue.blockedBy)) {
    patch.blockedBy = [...new Set(form.blockedBy)];
  }
  const labels = cleanLabels(form.labels);
  if (!sameSet(labels, issue.labels)) {
    patch.labels = labels;
  }
  return patch;
}

/** True when this change hands the issue to an agent, which makes the scheduler wake it. */
export const wakesAgent = (before: string | null, after: string | null | undefined): boolean =>
  typeof after === 'string' && after !== before;

/** One readable line for an API failure, including field-level validation details. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError && Array.isArray(error.details)) {
    const fields = (error.details as { path?: string; message?: string }[])
      .filter((detail) => detail.message)
      .map((detail) => (detail.path ? `${detail.path}: ${detail.message}` : detail.message));
    if (fields.length > 0) {
      return `${error.message} (${fields.join('; ')})`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/** The server's current revision when a document write lost the optimistic-concurrency race. */
export function conflictRevision(error: unknown): number | null | undefined {
  if (!(error instanceof ApiError) || error.status !== 409) {
    return undefined;
  }
  const details = error.details as { currentRevision?: unknown } | undefined;
  return typeof details?.currentRevision === 'number' ? details.currentRevision : null;
}
