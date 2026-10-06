import { ObjectId, type ClientSession } from 'mongodb';
import type { CreateProjectInput, Project, UpdateProjectInput } from '@conclavix/core';
import type { Collections, ProjectDoc } from '../../db.js';
import { conflict, isDuplicateKeyError, notFound } from '../../errors.js';
import { definedOnly } from '../../validation.js';

/** Convert a stored project to its domain representation with a hexadecimal ID. */
const toProject = (doc: ProjectDoc): Project => ({
  id: doc._id.toHexString(),
  key: doc.key,
  name: doc.name,
  description: doc.description,
  status: doc.status,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

export class ProjectRepository {
  /** Use the supplied collections for project persistence. */
  constructor(private readonly collections: Collections) {}

  /** Return all projects sorted by key. */
  async list(): Promise<Project[]> {
    const docs = await this.collections.projects.find().sort({ key: 1 }).toArray();
    return docs.map(toProject);
  }

  /** Return the project with the given ID, or raise a 404 error if it does not exist. */
  async get(id: ObjectId): Promise<Project> {
    const doc = await this.collections.projects.findOne({ _id: id });
    if (!doc) {
      throw notFound('Project');
    }
    return toProject(doc);
  }

  /** Create an active project from validated input, raising 409 if its key is already taken. */
  async create(input: CreateProjectInput, session?: ClientSession): Promise<Project> {
    const { key, name, description } = input;
    const now = new Date();
    const doc: ProjectDoc = {
      _id: new ObjectId(),
      key,
      name,
      description,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.collections.projects.insertOne(doc, session ? { session } : {});
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw conflict(`Project key ${input.key} is already taken`);
      }
      throw error;
    }
    return toProject(doc);
  }

  /** Apply defined fields from validated input, raising 404 if the project does not exist. */
  async update(id: ObjectId, input: UpdateProjectInput): Promise<Project> {
    const doc = await this.collections.projects.findOneAndUpdate(
      { _id: id },
      { $set: { ...definedOnly(input), updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!doc) {
      throw notFound('Project');
    }
    return toProject(doc);
  }
}
