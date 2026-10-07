import { ObjectId, type ClientSession } from 'mongodb';
import {
  SECRET_LIMITS,
  type CreateSecretInput,
  type Secret,
  type SecretAgentOption,
  type UpdateSecretInput,
} from '@conclavix/core';
import type { Collections } from '../../db.js';
import type { SecretDoc } from '../../db/secrets.js';
import { AppError, conflict, isDuplicateKeyError, notFound, unprocessable } from '../../errors.js';
import type { SecretBox } from '../settings/secret-box.js';

/** The sealed value is bound to its record, so a copied ciphertext does not open elsewhere. */
export const secretContext = (id: ObjectId): string => `secret:${id.toHexString()}`;

/** The API view: metadata only. */
export const toSecret = (doc: SecretDoc): Secret => ({
  id: doc._id.toHexString(),
  projectId: doc.projectId.toHexString(),
  name: doc.name,
  envName: doc.envName,
  agentIds: doc.agentIds.map((id) => id.toHexString()),
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
  lastUsedAt: doc.lastUsedAt,
  lastUsedRunId: doc.lastUsedRunId?.toHexString() ?? null,
});

/** What changed, for the audit log: field names and agent ids, never the value. */
export type SecretChanges = Record<string, string | boolean | string[]>;

async function unique<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw conflict('A secret with this name or variable already exists in the project');
    }
    throw error;
  }
}

/** Per-project secrets, sealed with the vault box. */
export class SecretRepository {
  constructor(
    private readonly collections: Collections,
    private readonly box: SecretBox,
  ) {}

  async list(projectId: ObjectId): Promise<Secret[]> {
    const docs = await this.collections.secrets
      .find({ projectId }, { collation: { locale: 'en', strength: 2 } })
      .sort({ name: 1 })
      .toArray();
    return docs.map(toSecret);
  }

  /** Every agent, with its code access; only agents with code access receive secrets. */
  async agentOptions(): Promise<SecretAgentOption[]> {
    const agents = await this.collections.agents
      .find({}, { projection: { name: 1, codeAccess: 1 } })
      .sort({ name: 1 })
      .toArray();
    return agents.map((agent) => ({
      id: agent._id.toHexString(),
      name: agent.name,
      codeAccess: agent.codeAccess ?? 'none',
    }));
  }

  async get(projectId: ObjectId, id: ObjectId, session?: ClientSession): Promise<SecretDoc> {
    const doc = await this.collections.secrets.findOne(
      { _id: id, projectId },
      session ? { session } : {},
    );
    if (!doc) throw notFound('Secret');
    return doc;
  }

  /** The plaintext; only the reveal route and the runner call this. */
  open(doc: SecretDoc): string {
    try {
      return this.box.open(doc.valueEncrypted, secretContext(doc._id));
    } catch {
      throw new AppError(
        422,
        'secret_unreadable',
        `The stored value of ${doc.envName} cannot be decrypted (was AUTH_SECRET changed?); enter it again`,
      );
    }
  }

  private async checkAgents(ids: readonly string[], session: ClientSession): Promise<ObjectId[]> {
    const objectIds = ids.map((id) => new ObjectId(id));
    const found = await this.collections.agents.countDocuments(
      { _id: { $in: objectIds } },
      { session },
    );
    if (found !== objectIds.length) throw unprocessable('Unknown agent in agentIds');
    return objectIds;
  }

  async create(
    projectId: ObjectId,
    input: CreateSecretInput,
    session: ClientSession,
  ): Promise<Secret> {
    const count = await this.collections.secrets.countDocuments({ projectId }, { session });
    if (count >= SECRET_LIMITS.perProject) {
      throw unprocessable(`A project can hold at most ${SECRET_LIMITS.perProject} secrets`);
    }
    const _id = new ObjectId();
    const now = new Date();
    const doc: SecretDoc = {
      _id,
      projectId,
      name: input.name,
      envName: input.envName,
      valueEncrypted: this.box.seal(input.value, secretContext(_id)),
      agentIds: await this.checkAgents(input.agentIds, session),
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      lastUsedRunId: null,
    };
    await unique(() => this.collections.secrets.insertOne(doc, { session }));
    return toSecret(doc);
  }

  async update(
    projectId: ObjectId,
    id: ObjectId,
    input: UpdateSecretInput,
    session: ClientSession,
  ): Promise<{ secret: Secret; changes: SecretChanges }> {
    const current = await this.get(projectId, id, session);
    const set: Partial<SecretDoc> = { updatedAt: new Date() };
    const changes: SecretChanges = {};
    if (input.name !== undefined && input.name !== current.name) {
      set.name = input.name;
      changes['name'] = true;
    }
    if (input.envName !== undefined && input.envName !== current.envName) {
      set.envName = input.envName;
      changes['envName'] = input.envName;
    }
    if (input.value !== undefined) {
      set.valueEncrypted = this.box.seal(input.value, secretContext(id));
      changes['value'] = 'replaced';
    }
    if (input.agentIds !== undefined) {
      const next = await this.checkAgents(input.agentIds, session);
      const before = new Set(current.agentIds.map((agent) => agent.toHexString()));
      const after = new Set(input.agentIds);
      const added = input.agentIds.filter((agent) => !before.has(agent));
      const removed = [...before].filter((agent) => !after.has(agent));
      set.agentIds = next;
      if (added.length > 0) changes['agentsAdded'] = added;
      if (removed.length > 0) changes['agentsRemoved'] = removed;
    }
    const doc = await unique(() =>
      this.collections.secrets.findOneAndUpdate(
        { _id: id, projectId },
        { $set: set },
        { returnDocument: 'after', session },
      ),
    );
    if (!doc) throw notFound('Secret');
    return { secret: toSecret(doc), changes };
  }

  async remove(projectId: ObjectId, id: ObjectId, session: ClientSession): Promise<SecretDoc> {
    const doc = await this.collections.secrets.findOneAndDelete(
      { _id: id, projectId },
      { session },
    );
    if (!doc) throw notFound('Secret');
    return doc;
  }
}
