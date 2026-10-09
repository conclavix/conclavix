import type { ObjectId } from 'mongodb';
import type { Collections } from '../db.js';

/**
 * A sealed value in the vault. Two kinds share the collection:
 *
 * - project secrets: `projectId` and `envName` set; the value reaches only the coding runs of
 *   the agents in `agentIds`, as the environment variable `envName` (docs/secrets.md);
 * - connection credentials: `connectionId` and `credentialKey` set, `envName` null, `projectId`
 *   the connection's project or null for an instance connection (docs/connections.md). They are
 *   never listed as project secrets and never become an environment variable of their own.
 */
export interface SecretDoc {
  _id: ObjectId;
  projectId: ObjectId | null;
  name: string;
  envName: string | null;
  valueEncrypted: string;
  agentIds: ObjectId[];
  connectionId?: ObjectId;
  credentialKey?: string;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
  lastUsedRunId: ObjectId | null;
}

/** Project secrets only: no connection credentials. */
export const PROJECT_SECRET = { connectionId: { $exists: false } } as const;

const NAMESPACE_NOT_FOUND = 26;
const INDEX_NOT_FOUND = 27;
const errorCode = (error: unknown): unknown => (error as { code?: unknown } | null)?.code;

/** Index names of the first release, which did not leave room for connection credentials. */
const FULL_INDEXES = ['projectId_1_envName_1', 'projectId_1_name_1'];

/** Unique variable and name per project for project secrets; one value per connection key. */
export async function ensureSecretIndexes(collections: Collections): Promise<void> {
  const existing = await collections.secrets.indexes().catch((error: unknown) => {
    if (errorCode(error) === NAMESPACE_NOT_FOUND) return [];
    throw error;
  });
  for (const index of existing) {
    if (FULL_INDEXES.includes(index.name ?? '') && !index['partialFilterExpression']) {
      // Another process starting at the same time may have dropped it already.
      await collections.secrets.dropIndex(index.name as string).catch((error: unknown) => {
        if (errorCode(error) !== INDEX_NOT_FOUND) throw error;
      });
    }
  }
  const projectSecrets = { envName: { $type: 'string' } };
  await collections.secrets.createIndex(
    { projectId: 1, envName: 1 },
    { unique: true, name: 'secret_env_unique', partialFilterExpression: projectSecrets },
  );
  await collections.secrets.createIndex(
    { projectId: 1, name: 1 },
    {
      unique: true,
      name: 'secret_name_unique',
      collation: { locale: 'en', strength: 2 },
      partialFilterExpression: projectSecrets,
    },
  );
  await collections.secrets.createIndex({ agentIds: 1 });
  await collections.secrets.createIndex(
    { connectionId: 1, credentialKey: 1 },
    {
      unique: true,
      name: 'secret_connection_key',
      partialFilterExpression: { connectionId: { $exists: true } },
    },
  );
}
