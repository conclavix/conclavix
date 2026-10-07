import type { ObjectId } from 'mongodb';
import pino from 'pino';
import { secretEnvNameProblem } from '@conclavix/core';
import type { Collections } from '../db.js';
import { PROJECT_SECRET } from '../db/secrets.js';
import type { AuditLog } from '../modules/audit/audit.js';
import type { SecretBox } from '../modules/settings/secret-box.js';
import { secretContext } from '../modules/secrets/repository.js';
import type { KnownSecret } from './redact.js';

const log = pino({ name: 'runner' });

/** A project secret one run receives. */
export interface RunSecret {
  id: ObjectId;
  name: string;
  envName: string;
  value: string;
}

export class RunSecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunSecretsError';
  }
}

/**
 * The secrets of `projectId` assigned to `agentId`, decrypted. Fails when one cannot be decrypted
 * or the runner has no key: a coding run without the secrets it was promised would fail later in
 * a less obvious way.
 */
export async function loadRunSecrets(
  collections: Collections,
  box: SecretBox | null,
  projectId: ObjectId,
  agentId: ObjectId,
): Promise<RunSecret[]> {
  const docs = await collections.secrets
    .find({ projectId, agentIds: agentId, envName: { $type: 'string' }, ...PROJECT_SECRET })
    .sort({ envName: 1 })
    .toArray();
  if (docs.length === 0) return [];
  if (!box) {
    throw new RunSecretsError(
      'this agent has project secrets, but the runner has no AUTH_SECRET to decrypt them',
    );
  }
  return docs.map((doc) => {
    const envName = doc.envName ?? '';
    const problem = secretEnvNameProblem(envName);
    if (problem) throw new RunSecretsError(`secret variable ${doc.envName}: ${problem}`);
    try {
      const value = box.open(doc.valueEncrypted, secretContext(doc._id));
      return { id: doc._id, name: doc.name, envName, value };
    } catch {
      throw new RunSecretsError(
        `secret ${doc.envName} cannot be decrypted (AUTH_SECRET differs from the API's?)`,
      );
    }
  });
}

/** Values the run log must not show, labelled with their variable name. */
export const secretsToRedact = (secrets: readonly RunSecret[]): KnownSecret[] =>
  secrets.map((secret) => ({ name: secret.envName, value: secret.value }));

/** The environment block entries of a coding run. */
export const secretEnv = (secrets: readonly RunSecret[]): Record<string, string> =>
  Object.fromEntries(secrets.map((secret) => [secret.envName, secret.value]));

/**
 * Record that a run received these secrets: one audit entry each (ids and names, never the
 * value) and the last use on the secret. Failures are logged by the audit log, not thrown.
 */
export async function recordSecretUse(
  collections: Collections,
  audit: AuditLog | undefined,
  secrets: readonly RunSecret[],
  run: { runId: ObjectId; agentId: ObjectId; projectId: ObjectId },
): Promise<void> {
  if (secrets.length === 0) return;
  const now = new Date();
  await collections.secrets
    .updateMany(
      { _id: { $in: secrets.map((secret) => secret.id) } },
      { $set: { lastUsedAt: now, lastUsedRunId: run.runId } },
    )
    .catch((error: unknown) =>
      log.warn(
        { runId: run.runId.toHexString(), err: error },
        'recording the last use of project secrets failed',
      ),
    );
  for (const secret of secrets) {
    await audit?.record({
      action: 'secret.used',
      actor: { type: 'system' },
      details: {
        secretId: secret.id.toHexString(),
        projectId: run.projectId.toHexString(),
        name: secret.name,
        envName: secret.envName,
        runId: run.runId.toHexString(),
        agentId: run.agentId.toHexString(),
      },
    });
  }
}
