import { z } from 'zod';
import type { AwaitingBoard } from './decision.js';
import { boardColumnIdSchema, idSchema } from './ids.js';

export const issueStatusSchema = z.enum([
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'cancelled',
]);

export const CLOSED_ISSUE_STATUSES = ['done', 'cancelled'] as const;

export const issuePrioritySchema = z.enum(['low', 'medium', 'high', 'urgent']);

export const issueKeySchema = z.string().regex(/^[A-Z][A-Z0-9]{1,5}-[1-9][0-9]*$/);

const labelsSchema = z.array(z.string().trim().min(1).max(40)).max(20);

export const createIssueSchema = z.strictObject({
  projectId: idSchema,
  title: z.string().trim().min(1).max(200),
  description: z.string().max(50000).default(''),
  status: issueStatusSchema.exclude(['done', 'cancelled']).optional(),
  columnId: boardColumnIdSchema.optional(),
  priority: issuePrioritySchema.default('medium'),
  parentId: idSchema.nullable().default(null),
  assigneeAgentId: idSchema.nullable().default(null),
  blockedBy: z.array(idSchema).max(50).default([]),
  labels: labelsSchema.default([]),
});

export const updateIssueSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(50000),
    status: issueStatusSchema,
    columnId: boardColumnIdSchema,
    priority: issuePrioritySchema,
    parentId: idSchema.nullable(),
    assigneeAgentId: idSchema.nullable(),
    blockedBy: z.array(idSchema).max(50),
    labels: labelsSchema,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');

export const listIssuesQuerySchema = z.strictObject({
  projectId: idSchema.optional(),
  status: z
    .string()
    .transform((value) => value.split(','))
    .pipe(z.array(issueStatusSchema))
    .optional(),
  assigneeAgentId: idSchema.optional(),
  parentId: z.union([idSchema, z.literal('none')]).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  after: idSchema.optional(),
});

export type IssueStatus = z.infer<typeof issueStatusSchema>;
export type IssuePriority = z.infer<typeof issuePrioritySchema>;
export type CreateIssueInput = z.infer<typeof createIssueSchema>;
export type UpdateIssueInput = z.infer<typeof updateIssueSchema>;
export type ListIssuesQuery = z.infer<typeof listIssuesQuerySchema>;

export interface Issue {
  id: string;
  key: string;
  projectId: string;
  number: number;
  title: string;
  description: string;
  status: IssueStatus;
  /** Board column; when null or not on the project's board, place the issue by status. */
  columnId: string | null;
  priority: IssuePriority;
  parentId: string | null;
  assigneeAgentId: string | null;
  blockedBy: string[];
  labels: string[];
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
  checkoutRunId: string | null;
  delegatedBy?: string | null;
  /** The issue's branch in the project repository (`cvx/<KEY>`), once its workspace was created. */
  branch: string | null;
  /** The open board decision the assignee waits for (request_board_decision), or null. */
  awaitingBoard: AwaitingBoard | null;
}
