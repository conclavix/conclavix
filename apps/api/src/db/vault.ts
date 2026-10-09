import type { Collection, Db } from 'mongodb';
import type { ConnectionDoc } from './connections.js';
import type { SecretDoc } from './secrets.js';

/** The vault: project secrets and connection credentials, and the connections themselves. */
export interface VaultCollections {
  secrets: Collection<SecretDoc>;
  connections: Collection<ConnectionDoc>;
}

export const vaultCollections = (db: Db): VaultCollections => ({
  secrets: db.collection<SecretDoc>('secrets'),
  connections: db.collection<ConnectionDoc>('connections'),
});
