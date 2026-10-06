import { ObjectId } from 'mongodb';
import type { Author, Comment, CreateCommentInput, PageQuery } from '@conclavix/core';
import type { CommentDoc, Database } from '../../db.js';
import { findIssueByRef } from '../issues/queries.js';
import { isActionable, requestWake } from '../scheduler/wakes.js';

const toComment = (doc: CommentDoc): Comment => ({
  id: doc._id.toHexString(),
  issueId: doc.issueId.toHexString(),
  author: doc.author,
  body: doc.body,
  createdAt: doc.createdAt,
});

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

  async create(issueRef: string, input: CreateCommentInput, author: Author): Promise<Comment> {
    const issue = await findIssueByRef(this.database.collections, issueRef);
    const doc: CommentDoc = {
      _id: new ObjectId(),
      issueId: issue._id,
      author,
      body: input.body,
      createdAt: new Date(),
    };
    await this.database.inTransaction(async (session) => {
      await this.database.collections.comments.insertOne(doc, { session });
      const authoredByAssignee =
        author.type === 'agent' && issue.assigneeAgentId?.toHexString() === author.agentId;
      if (issue.assigneeAgentId && isActionable(issue) && !authoredByAssignee) {
        await requestWake(
          this.database.collections,
          issue.assigneeAgentId,
          issue._id,
          'comment',
          session,
        );
      }
    });
    return toComment(doc);
  }
}
