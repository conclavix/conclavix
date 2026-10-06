import type { ClientSession, ObjectId } from 'mongodb';
import {
  CLOSED_ISSUE_STATUSES,
  DEFAULT_BOARD_COLUMNS,
  firstColumnFor,
  placeIssue,
  type BoardColumn,
  type IssueStatus,
} from '@conclavix/core';
import { boardLock, lock, type Collections, type IssueDoc } from '../../db.js';
import { notFound, unprocessable } from '../../errors.js';

export interface StoredBoard {
  revision: number;
  columns: BoardColumn[];
}

export interface Placement {
  status: IssueStatus;
  columnId: string;
}

/** Read a project's board, falling back to the default columns when none is stored. */
export async function readBoard(
  collections: Collections,
  projectId: ObjectId,
  session?: ClientSession,
): Promise<StoredBoard> {
  const project = await collections.projects.findOne(
    { _id: projectId },
    { projection: { board: 1 }, ...(session ? { session } : {}) },
  );
  if (!project) {
    throw notFound('Project');
  }
  return project.board ?? { revision: 0, columns: [...DEFAULT_BOARD_COLUMNS] };
}

/** Take the project's board lock in the transaction, then read the board. */
export async function lockBoard(
  collections: Collections,
  projectId: ObjectId,
  session: ClientSession,
): Promise<StoredBoard> {
  await lock(collections, boardLock(projectId), session);
  return readBoard(collections, projectId, session);
}

function columnById(columns: readonly BoardColumn[], columnId: string): BoardColumn {
  const column = columns.find((candidate) => candidate.id === columnId);
  if (!column) {
    throw unprocessable(`column ${columnId} is not on the project board`);
  }
  return column;
}

function homeOf(columns: readonly BoardColumn[], status: IssueStatus): BoardColumn {
  const column = firstColumnFor(columns, status);
  if (!column) {
    throw new Error(`board has no column for status ${status}`);
  }
  return column;
}

function assertMatches(column: BoardColumn, status: IssueStatus | undefined): void {
  if (status !== undefined && status !== column.status) {
    throw unprocessable(`column ${column.id} holds ${column.status} issues, not ${status}`);
  }
}

/** Column and status of a new issue: an explicit column wins, else the first of its status. */
export function placeNewIssue(
  columns: readonly BoardColumn[],
  input: { status?: IssueStatus | undefined; columnId?: string | undefined },
): Placement {
  if (input.columnId !== undefined) {
    const column = columnById(columns, input.columnId);
    assertMatches(column, input.status);
    if ((CLOSED_ISSUE_STATUSES as readonly IssueStatus[]).includes(column.status)) {
      throw unprocessable('cannot create an issue in a closed column');
    }
    return { status: column.status, columnId: column.id };
  }
  const status = input.status ?? 'todo';
  return { status, columnId: homeOf(columns, status).id };
}

/**
 * Column and status after a change: a column move sets the status to the column's category;
 * a status change keeps the current column when it fits, else uses the first of that status.
 */
export function placeChangedIssue(
  columns: readonly BoardColumn[],
  current: Pick<IssueDoc, 'status' | 'columnId'>,
  input: { status?: IssueStatus | undefined; columnId?: string | undefined },
): Placement | null {
  if (input.columnId !== undefined) {
    const column = columnById(columns, input.columnId);
    assertMatches(column, input.status);
    return { status: column.status, columnId: column.id };
  }
  if (input.status === undefined) {
    return null;
  }
  const column = placeIssue(columns, { status: input.status, columnId: current.columnId });
  return { status: input.status, columnId: (column ?? homeOf(columns, input.status)).id };
}
