import { ObjectId, type ClientSession } from 'mongodb';
import type { CreateIssueInput, Issue, ListIssuesQuery, UpdateIssueInput } from '@conclavix/core';
import { LOCKS, lock, type Database, type IssueDoc } from '../../db.js';
import { AppError, notFound, unprocessable } from '../../errors.js';
import { definedOnly } from '../../validation.js';
import { assertAgentExists, assertValidBlockers, assertValidParent, isClosed } from './graph.js';
import { isActionable, requestWake, wakeOnIssueChange } from '../scheduler/wakes.js';
import { delegatesTo } from '../org/links.js';
import { reportClosure } from '../org/reporting.js';
import { lockBoard, placeChangedIssue, placeNewIssue } from './columns.js';
import { toIssue } from './mapping.js';
import { findIssueByRef, listIssues, type IssuePage } from './queries.js';
import { resumeWaitingIssues } from './resume.js';
import { applyStatusChange } from './status-change.js';
import { assertAgentEnabledInProject } from '../projects/agent-access.js';

const toIds = (ids: string[]): ObjectId[] => [...new Set(ids)].map((id) => new ObjectId(id));
const toOptionalId = (id: string | null): ObjectId | null =>
  id === null ? null : new ObjectId(id);

/** An agent handing work down: who delegated, and from which of its issues. */
export interface Delegation {
  by: ObjectId;
  fromIssueId: ObjectId;
}

/**
 * Extra work inside an update's transaction, after the change is written: it can veto the change by
 * throwing (nothing is committed) or write records that belong to it, such as the reason comment.
 */
export type WithinUpdate = (
  session: ClientSession,
  before: IssueDoc,
  after: IssueDoc,
) => Promise<void>;

interface LockNeeds {
  graph: boolean;
  orgChart: boolean;
}

/** Issues: numbering, tree, blockers and assignment, with invariants enforced in transactions. */
export class IssueRepository {
  constructor(private readonly database: Database) {}

  private get collections() {
    return this.database.collections;
  }

  private transact<T>(
    needs: LockNeeds,
    work: (session: ClientSession) => Promise<T>,
    session?: ClientSession,
  ): Promise<T> {
    const run = async (session: ClientSession) => {
      if (needs.graph) {
        await lock(this.collections, LOCKS.issueGraph, session);
      }
      if (needs.orgChart) {
        await lock(this.collections, LOCKS.orgChart, session);
      }
      return work(session);
    };
    return session ? run(session) : this.database.inTransaction(run);
  }

  async list(query: ListIssuesQuery): Promise<IssuePage> {
    return listIssues(this.collections, query);
  }

  async get(ref: string): Promise<Issue> {
    return toIssue(await findIssueByRef(this.collections, ref));
  }

  async create(
    input: CreateIssueInput,
    delegation?: Delegation,
    session?: ClientSession,
  ): Promise<Issue> {
    const projectId = new ObjectId(input.projectId);
    const project = await this.collections.projects.findOne(
      { _id: projectId },
      session ? { session } : {},
    );
    if (!project) {
      throw unprocessable('projectId refers to a project that does not exist');
    }
    if (project.status !== 'active') {
      throw unprocessable('project is archived');
    }
    const parentId = toOptionalId(input.parentId);
    const assigneeAgentId = toOptionalId(input.assigneeAgentId);
    const blockedBy = toIds(input.blockedBy);
    const needs = {
      graph: parentId !== null || blockedBy.length > 0,
      orgChart: assigneeAgentId !== null,
    };
    const doc = await this.transact(
      needs,
      async (session) => {
        if (parentId) {
          await assertValidParent(this.collections, null, parentId, projectId, session);
        }
        await assertValidBlockers(this.collections, null, blockedBy, session);
        if (assigneeAgentId) {
          await assertAgentExists(this.collections, assigneeAgentId, session);
          await assertAgentEnabledInProject(this.collections, assigneeAgentId, projectId, session);
        }
        const delegatedBy = await this.checkDelegation(delegation, assigneeAgentId, session);
        const { columns } = await lockBoard(this.collections, projectId, session);
        const placement = placeNewIssue(columns, input);
        const number = await this.nextNumber(projectId, session);
        const now = new Date();
        const issue: IssueDoc = {
          ...input,
          ...placement,
          _id: new ObjectId(),
          projectId,
          key: `${project.key}-${number}`,
          number,
          parentId,
          assigneeAgentId,
          blockedBy,
          createdAt: now,
          updatedAt: now,
          closedAt: null,
          checkoutRunId: null,
          progress: 0,
          lastRunAt: null,
          delegatedBy,
          delegatedFromIssueId: delegatedBy ? (delegation?.fromIssueId ?? null) : null,
        };
        await this.collections.issues.insertOne(issue, { session });
        if (parentId) {
          await this.collections.issues.updateOne(
            { _id: parentId },
            { $inc: { progress: 1 } },
            { session },
          );
        }
        return issue;
      },
      session,
    );
    if (session) {
      // An enclosing transaction must commit the issue and its wake together.
      if (doc.assigneeAgentId && isActionable(doc)) {
        await requestWake(this.collections, doc.assigneeAgentId, doc._id, 'assigned', session);
      }
    } else {
      await wakeOnIssueChange(this.collections, null, doc);
    }
    return toIssue(doc);
  }

  /**
   * `wakes: false` leaves the wakes to a `within` that queues its own in the transaction, so a
   * post-commit wake cannot start a second run after the first one was already picked up.
   */
  async update(
    ref: string,
    input: UpdateIssueInput,
    within?: WithinUpdate,
    { wakes = true }: { wakes?: boolean } = {},
  ): Promise<Issue> {
    const { id } = await this.resolveId(ref);
    const moves = input.status !== undefined || input.columnId !== undefined;
    const needs = {
      graph: input.parentId !== undefined || input.blockedBy !== undefined || moves,
      orgChart: input.assigneeAgentId !== undefined || moves,
    };
    let resumed: ObjectId[] = [];
    const { before, after } = await this.transact(needs, async (session) => {
      resumed = [];
      const current = await this.collections.issues.findOne({ _id: id }, { session });
      if (!current) {
        throw notFound('Issue');
      }
      const placement = moves
        ? placeChangedIssue(
            (await lockBoard(this.collections, current.projectId, session)).columns,
            current,
            input,
          )
        : null;
      const effective = placement ? { ...input, ...placement } : input;
      const changes = await this.validateChanges(current, effective, session);
      const statusChanged = effective.status !== undefined && effective.status !== current.status;
      const updated = await this.collections.issues.findOneAndUpdate(
        { _id: id },
        statusChanged ? { $set: changes, $inc: { progress: 1 } } : { $set: changes },
        { returnDocument: 'after', session },
      );
      if (updated && within) {
        await within(session, current, updated);
      }
      if (updated && isClosed(updated.status) && !isClosed(current.status)) {
        // First, so a delegator waiting in_review gets this wake instead of a notification.
        resumed = await resumeWaitingIssues(this.collections, updated, session);
        await reportClosure(this.collections, updated, session);
      }
      return { before: current, after: updated };
    });
    if (!after) {
      throw notFound('Issue');
    }
    if (wakes) {
      await wakeOnIssueChange(this.collections, before, after, resumed);
    }
    return toIssue(after);
  }

  /**
   * For work an agent creates: the delegator to record when it assigns someone else, after checking
   * a direct `delegates` link under the org-chart lock (403 without one). Null otherwise.
   */
  private async checkDelegation(
    delegation: Delegation | undefined,
    assigneeId: ObjectId | null,
    session: ClientSession,
  ): Promise<ObjectId | null> {
    if (!delegation || !assigneeId || assigneeId.equals(delegation.by)) {
      return null;
    }
    if (!(await delegatesTo(this.collections, delegation.by, assigneeId, session))) {
      throw new AppError(403, 'forbidden', 'you can only delegate to agents you have a link to');
    }
    return delegation.by;
  }

  private async resolveId(ref: string): Promise<{ id: ObjectId }> {
    const doc = await findIssueByRef(this.collections, ref);
    return { id: doc._id };
  }

  private async validateChanges(
    current: IssueDoc,
    input: UpdateIssueInput,
    session: ClientSession,
  ): Promise<Partial<IssueDoc>> {
    const { parentId, assigneeAgentId, blockedBy, ...rest } = input;
    const changes: Partial<IssueDoc> = { ...definedOnly(rest), updatedAt: new Date() };
    if (parentId !== undefined) {
      changes.parentId = toOptionalId(parentId);
      if (changes.parentId) {
        await assertValidParent(
          this.collections,
          current._id,
          changes.parentId,
          current.projectId,
          session,
        );
      }
    }
    if (blockedBy !== undefined) {
      changes.blockedBy = toIds(blockedBy);
      await assertValidBlockers(this.collections, current._id, changes.blockedBy, session);
    }
    if (assigneeAgentId !== undefined) {
      changes.assigneeAgentId = toOptionalId(assigneeAgentId);
      if (changes.assigneeAgentId) {
        await assertAgentExists(this.collections, changes.assigneeAgentId, session);
        // Keeping an assignee who was disabled later is fine; only new assignments are checked.
        if (!changes.assigneeAgentId.equals(current.assigneeAgentId)) {
          await assertAgentEnabledInProject(
            this.collections,
            changes.assigneeAgentId,
            current.projectId,
            session,
          );
        }
      }
    }
    if (input.status !== undefined) {
      await applyStatusChange(this.collections, current, input.status, changes, session);
    }
    return changes;
  }

  private async nextNumber(projectId: ObjectId, session: ClientSession): Promise<number> {
    const counter = await this.collections.counters.findOneAndUpdate(
      { _id: `issue-number:${projectId.toHexString()}` },
      { $inc: { value: 1 } },
      { upsert: true, returnDocument: 'after', session },
    );
    if (!counter) {
      throw new Error('issue counter upsert returned no document');
    }
    return counter.value;
  }
}
