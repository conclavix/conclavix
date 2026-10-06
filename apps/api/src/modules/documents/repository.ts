import { ObjectId, type ClientSession } from 'mongodb';
import type {
  Author,
  DocumentRevision,
  DocumentSummary,
  WriteDocumentInput,
} from '@conclavix/core';
import type { Database, DocumentDoc, RevisionDoc } from '../../db.js';
import { conflict, isDuplicateKeyError, notFound } from '../../errors.js';
import { findIssueByRef } from '../issues/queries.js';

const toSummary = (doc: DocumentDoc): DocumentSummary => ({
  key: doc.key,
  issueId: doc.issueId.toHexString(),
  title: doc.title,
  revision: doc.revision,
  updatedAt: doc.updatedAt,
});

const toRevision = (doc: DocumentDoc, revision: RevisionDoc): DocumentRevision => ({
  ...toSummary(doc),
  title: revision.title,
  revision: revision.revision,
  body: revision.body,
  author: revision.author,
  createdAt: revision.createdAt,
});

const staleWrite = (current: number | null): Error =>
  conflict(
    current === null
      ? 'document does not exist yet; omit baseRevision to create it'
      : `document is at revision ${current}; send baseRevision ${current} to update it`,
    { currentRevision: current },
  );

/** Versioned documents on an issue; every write is a new revision guarded by baseRevision. */
export class DocumentRepository {
  constructor(private readonly database: Database) {}

  private get collections() {
    return this.database.collections;
  }

  private async findDocument(issueRef: string, key: string): Promise<DocumentDoc> {
    const issue = await findIssueByRef(this.collections, issueRef);
    const doc = await this.collections.documents.findOne({ issueId: issue._id, key });
    if (!doc) {
      throw notFound('Document');
    }
    return doc;
  }

  async list(issueRef: string): Promise<DocumentSummary[]> {
    const issue = await findIssueByRef(this.collections, issueRef);
    const docs = await this.collections.documents
      .find({ issueId: issue._id })
      .sort({ key: 1 })
      .toArray();
    return docs.map(toSummary);
  }

  async get(issueRef: string, key: string, revision?: number): Promise<DocumentRevision> {
    const doc = await this.findDocument(issueRef, key);
    const stored = await this.collections.revisions.findOne({
      documentId: doc._id,
      revision: revision ?? doc.revision,
    });
    if (!stored) {
      throw notFound('Revision');
    }
    return toRevision(doc, stored);
  }

  async revisions(issueRef: string, key: string): Promise<Omit<DocumentRevision, 'body'>[]> {
    const doc = await this.findDocument(issueRef, key);
    const stored = await this.collections.revisions
      .find({ documentId: doc._id }, { projection: { body: 0 } })
      .sort({ revision: -1 })
      .toArray();
    return stored.map((revision) => ({
      ...toSummary(doc),
      title: revision.title,
      revision: revision.revision,
      author: revision.author,
      createdAt: revision.createdAt,
    }));
  }

  async write(
    issueRef: string,
    key: string,
    input: WriteDocumentInput,
    author: Author,
  ): Promise<{ document: DocumentRevision; created: boolean }> {
    const issue = await findIssueByRef(this.collections, issueRef);
    try {
      return await this.database.inTransaction((session) =>
        this.writeInSession(issue._id, key, input, author, session),
      );
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        const current = await this.collections.documents.findOne({ issueId: issue._id, key });
        throw staleWrite(current?.revision ?? null);
      }
      throw error;
    }
  }

  private async writeInSession(
    issueId: ObjectId,
    key: string,
    input: WriteDocumentInput,
    author: Author,
    session: ClientSession,
  ): Promise<{ document: DocumentRevision; created: boolean }> {
    const now = new Date();
    const existing = await this.collections.documents.findOne({ issueId, key }, { session });
    if ((existing?.revision ?? undefined) !== input.baseRevision) {
      throw staleWrite(existing?.revision ?? null);
    }
    const doc: DocumentDoc = existing
      ? {
          ...existing,
          title: input.title ?? existing.title,
          revision: existing.revision + 1,
          updatedAt: now,
        }
      : {
          _id: new ObjectId(),
          issueId,
          key,
          title: input.title ?? key,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
    if (existing) {
      const result = await this.collections.documents.updateOne(
        { _id: existing._id, revision: existing.revision },
        { $set: { title: doc.title, revision: doc.revision, updatedAt: now } },
        { session },
      );
      if (result.modifiedCount !== 1) {
        throw staleWrite(existing.revision);
      }
    } else {
      await this.collections.documents.insertOne(doc, { session });
    }
    const revision: RevisionDoc = {
      _id: new ObjectId(),
      documentId: doc._id,
      revision: doc.revision,
      title: doc.title,
      body: input.body,
      author,
      createdAt: now,
    };
    const previous = existing
      ? await this.collections.revisions.findOne(
          { documentId: existing._id, revision: existing.revision },
          { session, projection: { title: 1, body: 1 } },
        )
      : null;
    await this.collections.revisions.insertOne(revision, { session });
    // Rewriting a document unchanged is no progress; it must not reset loop detection.
    const changed = !previous || previous.body !== input.body || previous.title !== doc.title;
    if (changed) {
      await this.collections.issues.updateOne(
        { _id: issueId },
        { $inc: { progress: 1 } },
        { session },
      );
    }
    return { document: toRevision(doc, revision), created: !existing };
  }
}
