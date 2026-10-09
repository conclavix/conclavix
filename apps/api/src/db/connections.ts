import type { ObjectId } from 'mongodb';
import type { ConnectionScope, ConnectionTestResult } from '@conclavix/core';
import type { Collections } from '../db.js';

/**
 * A connection to an external system (docs/connections.md). The config holds no secrets; the
 * credentials are vault entries (SecretDoc with `connectionId`).
 */
export interface ConnectionDoc {
  _id: ObjectId;
  name: string;
  type: string;
  scope: ConnectionScope;
  /** Set for scope project, null for scope instance. */
  projectId: ObjectId | null;
  config: Record<string, unknown>;
  agentIds: ObjectId[];
  allowPrivateNetwork: boolean;
  lastTest: ConnectionTestResult | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function ensureConnectionIndexes(collections: Collections): Promise<void> {
  await collections.connections.createIndex({ name: 1 }, { unique: true });
  await collections.connections.createIndex({ agentIds: 1 });
  await collections.connections.createIndex({ projectId: 1 });
}
