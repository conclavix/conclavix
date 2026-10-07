import { randomBytes } from 'node:crypto';
import type { ClientSession, Filter, ObjectId } from 'mongodb';
import {
  firstColumnFor,
  type Board,
  type BoardColumn,
  type UpdateBoardInput,
} from '@conclavix/core';
import { LOCKS, lock, type Collections, type Database, type IssueDoc } from '../../db.js';
import { AppError, conflict, unprocessable } from '../../errors.js';
import { lockBoard, readBoard } from '../issues/columns.js';
import { isClosed } from '../issues/graph.js';
import { resumeWaitingIssues } from '../issues/resume.js';
import { applyStatusChange } from '../issues/status-change.js';
import { wakeOnIssueChange } from '../scheduler/wakes.js';

const MAX_RELOCATED_ISSUES = 1000;

interface StatusMove {
  issue: IssueDoc;
  column: BoardColumn;
}

interface Transition {
  before: IssueDoc;
  after: IssueDoc;
}

const toBoard = (projectId: ObjectId, revision: number, columns: BoardColumn[]): Board => ({
  projectId: projectId.toHexString(),
  revision,
  columns,
});

/** Give columns without an id a generated one that is unique on the board. */
function withIds(columns: UpdateBoardInput['columns']): BoardColumn[] {
  const taken = new Set(columns.flatMap((column) => (column.id ? [column.id] : [])));
  return columns.map((column) => {
    let id = column.id;
    while (id === undefined || (column.id === undefined && taken.has(id))) {
      id = `c-${randomBytes(4).toString('hex')}`;
    }
    taken.add(id);
    return { ...column, id };
  });
}

/** Per-project board columns; layout changes relocate the issues they affect in one transaction. */
export class BoardRepository {
  constructor(private readonly database: Database) {}

  private get collections(): Collections {
    return this.database.collections;
  }

  async get(projectId: ObjectId): Promise<Board> {
    const { revision, columns } = await readBoard(this.collections, projectId);
    return toBoard(projectId, revision, columns);
  }

  /**
   * Replace the column list if `input.revision` is still current. Issues in deleted columns move
   * to the first remaining column of their status; issues in a column whose status changed get
   * that status, under the same rules and wakes as a status change on the issue itself.
   */
  async replace(projectId: ObjectId, input: UpdateBoardInput): Promise<Board> {
    const { board, transitions } = await this.database.inTransaction(async (session) => {
      await lock(this.collections, LOCKS.issueGraph, session);
      await lock(this.collections, LOCKS.orgChart, session);
      const stored = await lockBoard(this.collections, projectId, session);
      if (stored.revision !== input.revision) {
        throw conflict('the board was changed by someone else; reload it', {
          revision: stored.revision,
        });
      }
      const columns = withIds(input.columns);
      const transitions = await this.relocate(projectId, stored.columns, columns, session);
      const revision = stored.revision + 1;
      const written = await this.collections.projects.updateOne(
        { _id: projectId },
        { $set: { board: { revision, columns }, updatedAt: new Date() } },
        { session },
      );
      if (written.matchedCount !== 1) {
        throw new Error('project vanished while its board was locked');
      }
      // After every move and the new columns, so a resumed issue is read and placed as it now is.
      for (const { before, after } of transitions) {
        if (isClosed(after.status) && !isClosed(before.status)) {
          await resumeWaitingIssues(this.collections, after, session);
        }
      }
      return { board: toBoard(projectId, revision, columns), transitions };
    });
    for (const { before, after } of transitions) {
      await wakeOnIssueChange(this.collections, before, after);
    }
    return board;
  }

  private async relocate(
    projectId: ObjectId,
    previous: BoardColumn[],
    next: BoardColumn[],
    session: ClientSession,
  ): Promise<Transition[]> {
    const relocations = previous.map((column) => {
      const kept = next.find((candidate) => candidate.id === column.id);
      const target = kept ?? firstColumnFor(next, column.status);
      if (!target) {
        throw new Error(`board has no column for status ${column.status}`);
      }
      const shown = this.shownIn(projectId, column, previous);
      const changesStatus = target.status !== column.status;
      const filter: Filter<IssueDoc> = changesStatus
        ? shown
        : { $and: [shown, { columnId: { $ne: target.id } }] };
      return { target, changesStatus, filter };
    });
    const count = await this.collections.issues.countDocuments(
      { $or: relocations.map(({ filter }) => filter) },
      { session },
    );
    if (count > MAX_RELOCATED_ISSUES) {
      throw unprocessable(`board edit would relocate more than ${MAX_RELOCATED_ISSUES} issues`);
    }
    const pins = new Map<string, ObjectId[]>();
    const moves: StatusMove[] = [];
    for (const { target, changesStatus, filter } of relocations) {
      if (changesStatus) {
        const issues = await this.collections.issues.find(filter, { session }).toArray();
        moves.push(...issues.map((issue) => ({ issue, column: target })));
        continue;
      }
      const stale = await this.collections.issues
        .find(filter, { session, projection: { _id: 1 } })
        .toArray();
      pins.set(target.id, [...(pins.get(target.id) ?? []), ...stale.map((issue) => issue._id)]);
    }
    const now = new Date();
    for (const [columnId, ids] of pins) {
      if (ids.length > 0) {
        await this.collections.issues.updateMany(
          { _id: { $in: ids } },
          { $set: { columnId, updatedAt: now } },
          { session },
        );
      }
    }
    return this.changeStatuses(moves, session);
  }

  /** Issues the board shows in `column`, mirroring placeIssue from @conclavix/core. */
  private shownIn(
    projectId: ObjectId,
    column: BoardColumn,
    columns: BoardColumn[],
  ): Filter<IssueDoc> {
    const own: Filter<IssueDoc> = { columnId: column.id, status: column.status };
    if (firstColumnFor(columns, column.status)?.id !== column.id) {
      return { projectId, ...own };
    }
    const homes = columns
      .filter((other) => other.status === column.status)
      .map((other) => other.id);
    return { projectId, $or: [own, { status: column.status, columnId: { $nin: homes } }] };
  }

  /**
   * Apply status changes, retrying the ones that failed while others succeed so that order
   * inside an issue tree (children close before parents, parents reopen before children) works.
   */
  private async changeStatuses(moves: StatusMove[], session: ClientSession): Promise<Transition[]> {
    const transitions: Transition[] = [];
    let pending = moves;
    while (pending.length > 0) {
      const failed: StatusMove[] = [];
      let lastError: AppError | null = null;
      for (const move of pending) {
        try {
          transitions.push(await this.changeStatus(move, session));
        } catch (error) {
          if (!(error instanceof AppError)) {
            throw error;
          }
          failed.push(move);
          lastError = error;
        }
      }
      if (lastError && failed.length === pending.length) {
        const keys = failed.map((move) => move.issue.key).join(', ');
        throw new AppError(
          lastError.statusCode,
          lastError.code,
          `cannot move ${keys}: ${lastError.message}`,
        );
      }
      pending = failed;
    }
    return transitions;
  }

  private async changeStatus({ issue, column }: StatusMove, session: ClientSession) {
    const changes: Partial<IssueDoc> = {
      status: column.status,
      columnId: column.id,
      updatedAt: new Date(),
    };
    await applyStatusChange(this.collections, issue, column.status, changes, session);
    const after = await this.collections.issues.findOneAndUpdate(
      { _id: issue._id },
      { $set: changes, $inc: { progress: 1 } },
      { returnDocument: 'after', session },
    );
    if (!after) {
      throw new Error(`issue ${issue.key} vanished while the board was locked`);
    }
    return { before: issue, after };
  }
}
