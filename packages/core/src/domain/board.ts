import { z } from 'zod';
import { boardColumnIdSchema } from './ids.js';
import { issueStatusSchema, type IssueStatus } from './issue.js';

export const MAX_BOARD_COLUMNS = 20;

export const boardColumnSchema = z.strictObject({
  id: boardColumnIdSchema,
  title: z.string().trim().min(1).max(40),
  status: issueStatusSchema,
});

const columnInputSchema = boardColumnSchema.extend({ id: boardColumnIdSchema.optional() });

/** Ids must be unique and every status needs a column, so any status an agent sets has a home. */
function checkColumns(
  columns: { id?: string | undefined; status: IssueStatus }[],
  context: z.core.$RefinementCtx,
): void {
  const seen = new Set<string>();
  columns.forEach((column, index) => {
    if (column.id === undefined) {
      return;
    }
    if (seen.has(column.id)) {
      context.addIssue({
        code: 'custom',
        path: [index, 'id'],
        message: `duplicate column id ${column.id}`,
      });
    }
    seen.add(column.id);
  });
  for (const status of issueStatusSchema.options) {
    if (!columns.some((column) => column.status === status)) {
      context.addIssue({ code: 'custom', path: [], message: `no column for status ${status}` });
    }
  }
}

export const boardColumnsSchema = z
  .array(boardColumnSchema)
  .max(MAX_BOARD_COLUMNS)
  .superRefine(checkColumns);

export const updateBoardSchema = z.strictObject({
  revision: z.int().min(0),
  columns: z.array(columnInputSchema).max(MAX_BOARD_COLUMNS).superRefine(checkColumns),
});

export type BoardColumn = z.infer<typeof boardColumnSchema>;
export type UpdateBoardInput = z.infer<typeof updateBoardSchema>;

/** A project's board; revision 0 means the project still uses the default columns. */
export interface Board {
  projectId: string;
  revision: number;
  columns: BoardColumn[];
}

export const DEFAULT_BOARD_COLUMNS: readonly BoardColumn[] = [
  { id: 'backlog', title: 'Backlog', status: 'backlog' },
  { id: 'todo', title: 'To do', status: 'todo' },
  { id: 'in_progress', title: 'In progress', status: 'in_progress' },
  { id: 'in_review', title: 'In review', status: 'in_review' },
  { id: 'done', title: 'Done', status: 'done' },
  { id: 'cancelled', title: 'Cancelled', status: 'cancelled' },
];

/** The first column of a status category. */
export function firstColumnFor(
  columns: readonly BoardColumn[],
  status: IssueStatus,
): BoardColumn | undefined {
  return columns.find((column) => column.status === status);
}

/**
 * The column an issue is shown in: its own column when it exists and matches the status,
 * otherwise the first column of its status (old issues, deleted columns).
 */
export function placeIssue(
  columns: readonly BoardColumn[],
  issue: { status: IssueStatus; columnId?: string | null | undefined },
): BoardColumn | undefined {
  const own = columns.find((column) => column.id === issue.columnId);
  return own && own.status === issue.status ? own : firstColumnFor(columns, issue.status);
}
