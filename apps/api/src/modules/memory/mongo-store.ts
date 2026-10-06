import { ObjectId, type Filter } from 'mongodb';
import type { Memory } from '@conclavix/core';
import type { Collections, MemoryDoc } from '../../db.js';
import { isDuplicateKeyError } from '../../errors.js';
import {
  scopeFields,
  type MemoryBucket,
  type MemoryQuery,
  type MemoryStore,
  type MemoryWrite,
} from './store.js';

const titleKey = (title: string): string => title.trim().toLowerCase().replace(/\s+/g, ' ');

const toMemory = (doc: MemoryDoc): Memory => ({
  id: doc._id.toHexString(),
  scope: doc.scope,
  projectId: doc.projectId,
  agentId: doc.agentId,
  title: doc.title,
  body: doc.body,
  tags: doc.tags,
  author: doc.author,
  revision: doc.revision,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

const bucketFilter = (bucket: MemoryBucket): Filter<MemoryDoc> => scopeFields(bucket);

/** The built-in store: MongoDB with a weighted text index. Default for self-hosted installs. */
export class MongoMemoryStore implements MemoryStore {
  constructor(private readonly collections: Collections) {}

  async search(query: MemoryQuery): Promise<Memory[]> {
    if (query.buckets !== 'any' && query.buckets.length === 0) {
      return [];
    }
    const filter: Filter<MemoryDoc> =
      query.buckets === 'any' ? {} : { $or: query.buckets.map(bucketFilter) };
    if (query.scope) {
      filter.scope = query.scope;
    }
    if (query.text) {
      const docs = await this.collections.memories
        .find(
          { ...filter, $text: { $search: query.text } },
          { projection: { score: { $meta: 'textScore' } } },
        )
        .sort({ score: { $meta: 'textScore' } })
        .limit(query.limit)
        .toArray();
      return docs.map(toMemory);
    }
    const docs = await this.collections.memories
      .find(filter)
      .sort({ updatedAt: -1 })
      .limit(query.limit)
      .toArray();
    return docs.map(toMemory);
  }

  async save(write: MemoryWrite): Promise<{ memory: Memory; created: boolean }> {
    try {
      return await this.upsert(write);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        return this.upsert(write);
      }
      throw error;
    }
  }

  private async upsert(write: MemoryWrite): Promise<{ memory: Memory; created: boolean }> {
    const now = new Date();
    const result = await this.collections.memories.findOneAndUpdate(
      { ...scopeFields(write.bucket), titleKey: titleKey(write.title) },
      {
        $set: {
          title: write.title.trim(),
          body: write.body,
          tags: write.tags,
          author: write.author,
          updatedAt: now,
        },
        $inc: { revision: 1 },
        $setOnInsert: { _id: new ObjectId(), createdAt: now },
      },
      { upsert: true, returnDocument: 'after', includeResultMetadata: true },
    );
    if (!result.value) {
      throw new Error('memory upsert returned no document');
    }
    return {
      memory: toMemory(result.value),
      created: result.lastErrorObject?.['updatedExisting'] !== true,
    };
  }

  async get(id: string): Promise<Memory | null> {
    if (!ObjectId.isValid(id)) return null;
    const doc = await this.collections.memories.findOne({ _id: new ObjectId(id) });
    return doc ? toMemory(doc) : null;
  }

  async update(
    id: string,
    changes: Partial<Pick<Memory, 'title' | 'body' | 'tags'>>,
  ): Promise<Memory | null> {
    if (!ObjectId.isValid(id)) return null;
    const set: Partial<MemoryDoc> = { ...changes, updatedAt: new Date() };
    if (changes.title !== undefined) {
      set.titleKey = titleKey(changes.title);
    }
    const doc = await this.collections.memories.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: set, $inc: { revision: 1 } },
      { returnDocument: 'after' },
    );
    return doc ? toMemory(doc) : null;
  }

  async remove(id: string): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false;
    return (
      (await this.collections.memories.deleteOne({ _id: new ObjectId(id) })).deletedCount === 1
    );
  }
}
