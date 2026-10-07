import { ObjectId } from 'mongodb';
import type { Author, Comment, CreateCommentInput, PageQuery } from '@conclavix/core';
import type { CommentDoc, Database, IssueDoc } from '../../db.js';
import { conflict } from '../../errors.js';
import { findIssueByRef } from '../issues/queries.js';
import { IssueRepository } from '../issues/repository.js';
import { isActionable, requestWake } from '../scheduler/wakes.js';
import { settleDecision, type BoardOutcome } from '../decisions/records.js';

const toComment = (doc: CommentDoc): Comment => ({
  id: doc._id.toHexString(),
  issueId: doc.issueId.toHexString(),
  author: doc.author,
  body: doc.body,
  createdAt: doc.createdAt,
});

const isBoardSide = (author: Author): boolean => author.type === 'board' || author.type === 'user';

/** A board or user comment answers the assignee's in_review question; agent comments never do. */
const answersReview = (issue: Pick<IssueDoc, 'status' | 'assigneeAgentId'>, author: Author) =>
  issue.status === 'in_review' && issue.assigneeAgentId !== null && isBoardSide(author);

/** How a board-side comment settles an open board decision on the issue (default: answered). */
export interface CommentOptions {
  outcome?: BoardOutcome;
  /** The decision the comment answers: it must still be the issue's open one, else 409. */
  decisionId?: ObjectId;
}

/** The comment was meant for a decision that is no longer the issue's open question. */
const decisionNotOpen = () => conflict('the decision is no longer open');

/** The issue left in_review between the read and the transaction; post the comment normally. */
class ReviewAlreadyAnswered extends Error {}

/** Comments on an issue; append-only so the thread is an audit trail. */
export class CommentRepository {
  constructor(private readonly database: Database) {}

  async list(
    issueRef: string,
    page: PageQuery,
  ): Promise<{ items: Comment[]; nextCursor: string | null }> {
    const issue = await findIssueByRef(this.database.collections, issueRef);
    const filter = page.after
      ? { issueId: issue._id, _id: { $gt: new ObjectId(page.after) } }
      : { issueId: issue._id };
    const docs = await this.database.collections.comments
      .find(filter)
      .sort({ _id: 1 })
      .limit(page.limit + 1)
      .toArray();
    const items = docs.slice(0, page.limit);
    const last = items.at(-1);
    return {
      items: items.map(toComment),
      nextCursor: docs.length > page.limit && last ? last._id.toHexString() : null,
    };
  }

  async create(
    issueRef: string,
    input: CreateCommentInput,
    author: Author,
    { outcome = 'answered', decisionId }: CommentOptions = {},
  ): Promise<Comment> {
    const issue = await findIssueByRef(this.database.collections, issueRef);
    const doc: CommentDoc = {
      _id: new ObjectId(),
      issueId: issue._id,
      author,
      body: input.body,
      createdAt: new Date(),
    };
    let current = issue;
    if (answersReview(issue, author)) {
      if (await this.answerReview(issue, doc, outcome, decisionId)) {
        return toComment(doc);
      }
      current = await findIssueByRef(this.database.collections, issue._id.toHexString());
    }
    await this.database.inTransaction(async (session) => {
      if (decisionId && !current.awaitingBoard?.decisionId.equals(decisionId)) {
        throw decisionNotOpen();
      }
      await this.database.collections.comments.insertOne(doc, { session });
      // Without an assignee the issue stays in_review, but the board has still answered.
      if (current.awaitingBoard && isBoardSide(author)) {
        const awaitingId = current.awaitingBoard.decisionId;
        await this.database.collections.issues.updateOne(
          { _id: current._id, 'awaitingBoard.decisionId': awaitingId },
          { $set: { awaitingBoard: null, updatedAt: new Date() } },
          { session },
        );
        const settled = await settleDecision(
          this.database.collections,
          awaitingId,
          outcome,
          author,
          doc.body,
          session,
        );
        if (decisionId && !settled) {
          throw decisionNotOpen();
        }
      }
      const authoredByAssignee =
        author.type === 'agent' && current.assigneeAgentId?.toHexString() === author.agentId;
      if (current.assigneeAgentId && isActionable(current) && !authoredByAssignee) {
        await requestWake(
          this.database.collections,
          current.assigneeAgentId,
          current._id,
          'comment',
          session,
        );
      }
    });
    return toComment(doc);
  }

  /**
   * Hand an in_review issue back to its assignee: the comment and the move to in_progress commit
   * together (through the issue update, so the board column follows), and the assignee gets a
   * comment wake under the usual run limits. The agent sets in_review again when it needs the
   * board once more. False, with nothing written, when the issue left in_review meanwhile (another
   * answer, a status change), also when that made the move itself invalid; the caller then posts
   * the comment the ordinary way.
   */
  private async answerReview(
    issue: IssueDoc,
    doc: CommentDoc,
    outcome: BoardOutcome,
    decisionId: ObjectId | undefined,
  ): Promise<boolean> {
    const { collections } = this.database;
    try {
      await new IssueRepository(this.database).update(
        issue._id.toHexString(),
        { status: 'in_progress' },
        async (session, before) => {
          if (!answersReview(before, doc.author) || !before.assigneeAgentId) {
            throw new ReviewAlreadyAnswered();
          }
          if (decisionId && !before.awaitingBoard?.decisionId.equals(decisionId)) {
            throw decisionNotOpen();
          }
          await collections.comments.insertOne(doc, { session });
          if (before.awaitingBoard) {
            // The move out of in_review clears awaitingBoard; this records how it was settled.
            const settled = await settleDecision(
              collections,
              before.awaitingBoard.decisionId,
              outcome,
              doc.author,
              doc.body,
              session,
            );
            if (decisionId && !settled) {
              throw decisionNotOpen();
            }
          }
          await requestWake(collections, before.assigneeAgentId, before._id, 'comment', session);
        },
        // in_review to in_progress is neither a close nor a reassignment; the comment wake suffices.
        { wakes: false },
      );
      return true;
    } catch (error) {
      if (error instanceof ReviewAlreadyAnswered) {
        return false;
      }
      // update() validates the move before `within` runs, so an issue that left in_review
      // meanwhile can fail there (e.g. reopening under a closed parent); fall back in that case too.
      // A failing re-read (e.g. the same outage) must not hide why the update failed.
      const now = await findIssueByRef(collections, issue._id.toHexString()).catch(() => null);
      if (now && !answersReview(now, doc.author)) {
        return false;
      }
      throw error;
    }
  }
}
