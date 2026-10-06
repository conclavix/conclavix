import { ObjectId, type Filter } from 'mongodb';
import { issueKeySchema, type Issue, type ListIssuesQuery } from '@conclavix/core';
import type { Collections, IssueDoc } from '../../db.js';
import { notFound } from '../../errors.js';
import { toIssue } from './mapping.js';

export interface IssuePage {
  items: Issue[];
  nextCursor: string | null;
}

/** Find an issue by its id or its key (e.g. CVX-12). */
export async function findIssueByRef(collections: Collections, ref: string): Promise<IssueDoc> {
  let filter: Filter<IssueDoc> | null = null;
  if (/^[a-f0-9]{24}$/.test(ref)) {
    filter = { _id: new ObjectId(ref) };
  } else if (issueKeySchema.safeParse(ref).success) {
    filter = { key: ref };
  }
  const doc = filter ? await collections.issues.findOne(filter) : null;
  if (!doc) {
    throw notFound('Issue');
  }
  return doc;
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function buildFilter(query: ListIssuesQuery): Filter<IssueDoc> {
  const filter: Filter<IssueDoc> = {};
  if (query.projectId) {
    filter.projectId = new ObjectId(query.projectId);
  }
  if (query.status) {
    filter.status = { $in: query.status };
  }
  if (query.assigneeAgentId) {
    filter.assigneeAgentId = new ObjectId(query.assigneeAgentId);
  }
  if (query.parentId) {
    filter.parentId = query.parentId === 'none' ? null : new ObjectId(query.parentId);
  }
  if (query.q) {
    const pattern = escapeRegex(query.q);
    filter.$or = [
      { key: { $regex: `^${pattern}`, $options: 'i' } },
      { title: { $regex: pattern, $options: 'i' } },
    ];
  }
  if (query.after) {
    filter._id = { $gt: new ObjectId(query.after) };
  }
  return filter;
}

/** List issues in creation order with cursor pagination. */
export async function listIssues(
  collections: Collections,
  query: ListIssuesQuery,
): Promise<IssuePage> {
  const docs = await collections.issues
    .find(buildFilter(query))
    .sort({ _id: 1 })
    .limit(query.limit + 1)
    .toArray();
  const hasMore = docs.length > query.limit;
  const page = hasMore ? docs.slice(0, query.limit) : docs;
  const last = page.at(-1);
  return {
    items: page.map(toIssue),
    nextCursor: hasMore && last ? last._id.toHexString() : null,
  };
}
