import type { ObjectId } from 'mongodb';
import type { Collections } from '../db.js';

/**
 * A project secret: the value is sealed with the vault SecretBox and reaches only the coding runs
 * of the agents in `agentIds`, as the environment variable `envName`.
 */
export interface SecretDoc {
  _id: ObjectId;
  projectId: ObjectId;
  name: string;
  envName: string;
  valueEncrypted: string;
  agentIds: ObjectId[];
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
  lastUsedRunId: ObjectId | null;
}

/** Unique variable and name per project; lookups by agent for the runner. */
export async function ensureSecretIndexes(collections: Collections): Promise<void> {
  await collections.secrets.createIndex({ projectId: 1, envName: 1 }, { unique: true });
  await collections.secrets.createIndex(
    { projectId: 1, name: 1 },
    { unique: true, collation: { locale: 'en', strength: 2 } },
  );
  await collections.secrets.createIndex({ agentIds: 1 });
}
