import { ObjectId, type ClientSession } from 'mongodb';
import type { CreateSkillInput, Skill, SkillSummary, UpdateSkillInput } from '@conclavix/core';
import { LOCKS, lock, type Collections, type Database, type SkillDoc } from '../../db.js';
import { conflict, isDuplicateKeyError, notFound, unprocessable } from '../../errors.js';
import { definedOnly } from '../../validation.js';

/** Convert a stored skill to its domain representation with a hexadecimal ID. */
const toSkill = (doc: SkillDoc): Skill => ({
  id: doc._id.toHexString(),
  name: doc.name,
  description: doc.description,
  body: doc.body,
  files: doc.files,
  source: doc.source ? { ...doc.source, sourceId: doc.source.sourceId.toHexString() } : null,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

/** Run a write and translate duplicate-key errors into skill-name conflicts. */
async function withUniqueName<T>(name: string | undefined, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw conflict(`A skill named ${name ?? ''} already exists`);
    }
    throw error;
  }
}

/**
 * Lock skill assignments and raise 422 unless every ID names an existing skill.
 * Callers must run inside a transaction so a concurrent skill deletion cannot slip through.
 */
export async function assertSkillsExist(
  collections: Collections,
  skillIds: string[],
  session: ClientSession,
): Promise<ObjectId[]> {
  await lock(collections, LOCKS.skillAssignments, session);
  const ids = skillIds.map((id) => new ObjectId(id));
  const found = await collections.skills
    .find({ _id: { $in: ids } }, { session, projection: { _id: 1 } })
    .toArray();
  const known = new Set(found.map((doc) => doc._id.toHexString()));
  const missing = skillIds.filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw unprocessable('Unknown skill ids', { missing });
  }
  return ids;
}

export class SkillRepository {
  /** Use the supplied database for skill persistence and transactional deletes. */
  constructor(private readonly database: Database) {}

  /** Return the skill collection associated with this repository. */
  private get skills() {
    return this.database.collections.skills;
  }

  /** Return summaries of all skills sorted by name, without bodies or file contents. */
  async list(): Promise<SkillSummary[]> {
    const docs = await this.skills
      .aggregate<SkillSummary & { _id: ObjectId }>([
        { $sort: { name: 1 } },
        {
          $project: {
            name: 1,
            description: 1,
            updatedAt: 1,
            fileCount: { $size: { $ifNull: ['$files', []] } },
            sourceProvider: { $ifNull: ['$source.provider', null] },
          },
        },
      ])
      .toArray();
    return docs.map(({ _id, name, description, fileCount, sourceProvider, updatedAt }) => ({
      id: _id.toHexString(),
      name,
      description,
      fileCount,
      sourceProvider: sourceProvider ?? null,
      updatedAt,
    }));
  }

  /** Return the skill with the given ID, or raise a 404 error if it does not exist. */
  async get(id: ObjectId): Promise<Skill> {
    const doc = await this.skills.findOne({ _id: id });
    if (!doc) {
      throw notFound('Skill');
    }
    return toSkill(doc);
  }

  /** Create a skill from validated input, raising 409 if its name is already taken. */
  async create(input: CreateSkillInput): Promise<Skill> {
    const now = new Date();
    const doc: SkillDoc = { _id: new ObjectId(), ...input, createdAt: now, updatedAt: now };
    await withUniqueName(input.name, () => this.skills.insertOne(doc));
    return toSkill(doc);
  }

  /** Apply defined fields from validated input; files, when given, replace the whole set. */
  async update(id: ObjectId, input: UpdateSkillInput): Promise<Skill> {
    const doc = await withUniqueName(input.name, () =>
      this.skills.findOneAndUpdate(
        { _id: id },
        { $set: { ...definedOnly(input), updatedAt: new Date() } },
        { returnDocument: 'after' },
      ),
    );
    if (!doc) {
      throw notFound('Skill');
    }
    return toSkill(doc);
  }

  /** Delete a skill, raising 409 with the assigned agents' names while any agent still uses it. */
  async remove(id: ObjectId): Promise<void> {
    const { collections } = this.database;
    await this.database.inTransaction(async (session) => {
      await lock(collections, LOCKS.skillAssignments, session);
      const agents = await collections.agents
        .find({ skillIds: id }, { session, projection: { name: 1 } })
        .sort({ name: 1 })
        .toArray();
      if (agents.length > 0) {
        throw conflict('Skill is still assigned to agents; unassign it first', {
          agents: agents.map((agent) => agent.name),
        });
      }
      const result = await collections.skills.deleteOne({ _id: id }, { session });
      if (result.deletedCount === 0) {
        throw notFound('Skill');
      }
    });
  }
}
