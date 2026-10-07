import { ObjectId, type ClientSession } from 'mongodb';
import type { Connection, CreateConnectionInput, UpdateConnectionInput } from '@conclavix/core';
import type { Database } from '../../db.js';
import type { ConnectionDoc } from '../../db/connections.js';
import type { SecretDoc } from '../../db/secrets.js';
import { AppError, conflict, isDuplicateKeyError, notFound, unprocessable } from '../../errors.js';
import { Redactor } from '../../runner/redact.js';
import type { SecretBox } from '../settings/secret-box.js';
import { checkAgentIds } from '../secrets/agent-ids.js';
import { secretContext } from '../secrets/repository.js';
import { assertSafeConnectionUrl } from './net.js';
import { connectionType } from './types/index.js';
import type { ConnectionContext, ConnectionType } from './types/types.js';

const TEST_TIMEOUT_MS = 15_000;

/** What changed, for the audit log: field names, keys and ids, never a credential value. */
export type ConnectionChanges = Record<string, string | boolean | string[]>;

export const toConnection = (doc: ConnectionDoc, credentials: SecretDoc[]): Connection => {
  const type = connectionType(doc.type);
  const stored = new Set(credentials.map((entry) => entry.credentialKey ?? ''));
  const keys = type ? safeKeys(type, doc.config) : [...stored];
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    type: doc.type,
    scope: doc.scope,
    projectId: doc.projectId?.toHexString() ?? null,
    config: doc.config,
    credentials: keys.map((key) => ({ key, set: stored.has(key) })),
    agentIds: doc.agentIds.map((id) => id.toHexString()),
    allowPrivateNetwork: doc.allowPrivateNetwork,
    lastTest: doc.lastTest,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
};

function safeKeys(type: ConnectionType, config: Record<string, unknown>): string[] {
  const parsed = type.configSchema.safeParse(config);
  return parsed.success ? type.credentialKeys(parsed.data) : [];
}

function typeOf(id: string): ConnectionType {
  const type = connectionType(id);
  if (!type) throw unprocessable(`Unknown connection type ${id}`);
  return type;
}

/** Validate a config against its type and the SSRF rules; returns the parsed config. */
function checkConfig(
  type: ConnectionType,
  config: Record<string, unknown>,
  allowPrivate: boolean,
): Record<string, unknown> {
  const parsed = type.configSchema.parse(config);
  for (const url of type.urls(parsed)) assertSafeConnectionUrl(url, allowPrivate);
  return parsed;
}

async function unique<T>(name: string | undefined, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isDuplicateKeyError(error)) throw conflict(`A connection named ${name ?? ''} exists`);
    throw error;
  }
}

/** Connections and their vault-stored credentials. */
export class ConnectionService {
  constructor(
    private readonly database: Database,
    private readonly box: SecretBox,
  ) {}

  private get collections() {
    return this.database.collections;
  }

  private credentialsOf(ids: ObjectId[], session?: ClientSession): Promise<SecretDoc[]> {
    return this.collections.secrets
      .find({ connectionId: { $in: ids } }, session ? { session } : {})
      .toArray();
  }

  async list(projectId?: ObjectId): Promise<Connection[]> {
    const docs = await this.collections.connections
      .find(projectId ? { projectId } : {})
      .sort({ name: 1 })
      .toArray();
    const credentials = await this.credentialsOf(docs.map((doc) => doc._id));
    return docs.map((doc) =>
      toConnection(
        doc,
        credentials.filter((entry) => entry.connectionId?.equals(doc._id)),
      ),
    );
  }

  async getDoc(id: ObjectId, session?: ClientSession): Promise<ConnectionDoc> {
    const doc = await this.collections.connections.findOne({ _id: id }, session ? { session } : {});
    if (!doc) throw notFound('Connection');
    return doc;
  }

  async view(id: ObjectId, session?: ClientSession): Promise<Connection> {
    const doc = await this.getDoc(id, session);
    return toConnection(doc, await this.credentialsOf([doc._id], session));
  }

  private async checkProject(id: string | undefined, session: ClientSession) {
    if (id === undefined) return null;
    const projectId = new ObjectId(id);
    if (!(await this.collections.projects.findOne({ _id: projectId }, { session }))) {
      throw notFound('Project');
    }
    return projectId;
  }

  /** Store, replace or remove credential values; keys must belong to the config. */
  private async writeCredentials(
    doc: ConnectionDoc,
    keys: readonly string[],
    values: Record<string, string | null>,
    session: ClientSession,
  ): Promise<string[]> {
    const changed: string[] = [];
    for (const [key, value] of Object.entries(values)) {
      if (!keys.includes(key)) throw unprocessable(`${key} is not a credential of this config`);
      const filter = { connectionId: doc._id, credentialKey: key };
      if (value === null) {
        const removed = await this.collections.secrets.deleteOne(filter, { session });
        if (removed.deletedCount > 0) changed.push(key);
        continue;
      }
      const existing = await this.collections.secrets.findOne(filter, { session });
      const id = existing?._id ?? new ObjectId();
      const now = new Date();
      await this.collections.secrets.updateOne(
        { _id: id },
        {
          $set: {
            ...filter,
            projectId: doc.projectId,
            name: `${doc.name}:${key}`,
            envName: null,
            valueEncrypted: this.box.seal(value, secretContext(id)),
            agentIds: [],
            updatedAt: now,
          },
          $setOnInsert: { createdAt: now, lastUsedAt: null, lastUsedRunId: null },
        },
        { upsert: true, session },
      );
      changed.push(key);
    }
    return changed;
  }

  async create(input: CreateConnectionInput, session: ClientSession): Promise<Connection> {
    const type = typeOf(input.type);
    const config = checkConfig(type, input.config, input.allowPrivateNetwork);
    const now = new Date();
    const doc: ConnectionDoc = {
      _id: new ObjectId(),
      name: input.name,
      type: type.id,
      scope: input.scope,
      projectId: await this.checkProject(input.projectId, session),
      config,
      agentIds: await checkAgentIds(this.collections, input.agentIds, session),
      allowPrivateNetwork: input.allowPrivateNetwork,
      lastTest: null,
      createdAt: now,
      updatedAt: now,
    };
    await unique(input.name, () => this.collections.connections.insertOne(doc, { session }));
    await this.writeCredentials(doc, type.credentialKeys(config), input.credentials, session);
    return this.view(doc._id, session);
  }

  async update(
    id: ObjectId,
    input: UpdateConnectionInput,
    session: ClientSession,
  ): Promise<{ connection: Connection; changes: ConnectionChanges }> {
    const current = await this.getDoc(id, session);
    const type = typeOf(current.type);
    const allowPrivate = input.allowPrivateNetwork ?? current.allowPrivateNetwork;
    const config = checkConfig(type, input.config ?? current.config, allowPrivate);
    const set: Partial<ConnectionDoc> = { updatedAt: new Date(), config };
    const changes: ConnectionChanges = {};
    if (input.name !== undefined && input.name !== current.name) {
      set.name = input.name;
      changes['name'] = true;
    }
    if (input.allowPrivateNetwork !== undefined && allowPrivate !== current.allowPrivateNetwork) {
      set.allowPrivateNetwork = allowPrivate;
      changes['allowPrivateNetwork'] = allowPrivate;
    }
    const urlsChanged =
      JSON.stringify(type.urls(config)) !==
      JSON.stringify(type.urls(type.configSchema.parse(current.config)));
    if (JSON.stringify(config) !== JSON.stringify(current.config)) changes['config'] = true;
    if (input.agentIds !== undefined) {
      set.agentIds = await checkAgentIds(
        this.collections,
        input.agentIds,
        session,
        current.agentIds,
      );
      changes['agentIds'] = input.agentIds;
    }
    if (urlsChanged || Object.keys(changes).includes('config')) set.lastTest = null;
    const doc = await unique(input.name, () =>
      this.collections.connections.findOneAndUpdate(
        { _id: id },
        { $set: set },
        { returnDocument: 'after', session },
      ),
    );
    if (!doc) throw notFound('Connection');
    const keys = type.credentialKeys(config);
    const written = await this.updateCredentials(
      doc,
      keys,
      urlsChanged,
      input.credentials,
      session,
    );
    if (written.length > 0) changes['credentials'] = written;
    if (changes['name']) {
      for (const key of keys) {
        await this.collections.secrets.updateOne(
          { connectionId: id, credentialKey: key },
          { $set: { name: `${doc.name}:${key}` } },
          { session },
        );
      }
    }
    return { connection: await this.view(id, session), changes };
  }

  /**
   * Apply the credential part of an update: values entered are written, keys the config dropped
   * are removed, and so are stored values not entered again when the URLs changed.
   */
  private async updateCredentials(
    doc: ConnectionDoc,
    keys: string[],
    urlsChanged: boolean,
    input: Record<string, string | null> | undefined,
    session: ClientSession,
  ): Promise<string[]> {
    for (const key of Object.keys(input ?? {})) {
      if (!keys.includes(key)) throw unprocessable(`${key} is not a credential of this config`);
    }
    const stale = (await this.credentialsOf([doc._id], session))
      .map((entry) => entry.credentialKey ?? '')
      .filter((key) => !keys.includes(key) || (urlsChanged && !(key in (input ?? {}))));
    const values = { ...Object.fromEntries(stale.map((key) => [key, null])), ...input };
    return this.writeCredentials(doc, [...new Set([...keys, ...stale])], values, session);
  }

  async remove(id: ObjectId, session: ClientSession): Promise<ConnectionDoc> {
    const doc = await this.collections.connections.findOneAndDelete({ _id: id }, { session });
    if (!doc) throw notFound('Connection');
    await this.collections.secrets.deleteMany({ connectionId: id }, { session });
    return doc;
  }

  /** The decrypted credentials of a connection, by key. */
  async credentials(doc: ConnectionDoc): Promise<Record<string, string>> {
    const entries = await this.credentialsOf([doc._id]);
    try {
      return Object.fromEntries(
        entries.map((entry) => [
          entry.credentialKey ?? '',
          this.box.open(entry.valueEncrypted, secretContext(entry._id)),
        ]),
      );
    } catch {
      throw new AppError(
        422,
        'secret_unreadable',
        'A stored credential cannot be decrypted (was AUTH_SECRET changed?); enter it again',
      );
    }
  }

  /** Run the type's test with the stored credentials and keep the outcome on the connection. */
  async test(id: ObjectId): Promise<Connection> {
    const doc = await this.getDoc(id);
    const type = typeOf(doc.type);
    const credentials = await this.credentials(doc);
    const context: ConnectionContext<Record<string, unknown>> = {
      name: doc.name,
      config: type.configSchema.parse(doc.config),
      credentials,
      allowPrivateNetwork: doc.allowPrivateNetwork,
      timeoutMs: TEST_TIMEOUT_MS,
    };
    const missing = type.credentialKeys(context.config).filter((key) => !(key in credentials));
    let outcome = missing.length
      ? { ok: false, summary: `No stored value for ${missing.join(', ')}` }
      : await type.test(context).catch((error: unknown) => {
          if (error instanceof AppError) return { ok: false, summary: error.message };
          throw error;
        });
    // A server could echo a credential in an error; the stored result never holds one.
    const redactor = new Redactor(
      Object.entries(credentials).map(([key, value]) => ({ name: key, value })),
    );
    outcome = redactor.deep(outcome);
    const lastTest = { ...outcome, at: new Date() };
    // A connection edited while the test ran keeps its cleared result.
    await this.collections.connections.updateOne(
      { _id: id, updatedAt: doc.updatedAt },
      { $set: { lastTest } },
    );
    return this.view(id);
  }
}
