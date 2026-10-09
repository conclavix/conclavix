import { loadConfig } from '@conclavix/core';
import pino from 'pino';
import { connectDatabase } from './db.js';
import { StoredRedactionError, redactStoredRunLogs } from './modules/runs/redact-stored.js';
import { Redactor } from './runner/redact.js';
import { knownSecretsFromEnv } from './runner/secrets.js';
import { vaultBox } from './modules/settings/secret-box.js';
import { secretContext } from './modules/secrets/repository.js';
import type { KnownSecret } from './runner/redact.js';
import type { Database } from './db.js';

/** The current values of all project secrets, when AUTH_SECRET is there to open them. */
async function projectSecrets(
  database: Database,
  authSecret: string | undefined,
  log: pino.Logger,
) {
  if (!authSecret) return [];
  const box = vaultBox(authSecret);
  const found: KnownSecret[] = [];
  for await (const doc of database.collections.secrets.find()) {
    try {
      found.push({
        name: doc.envName ?? doc.name,
        value: box.open(doc.valueEncrypted, secretContext(doc._id)),
      });
    } catch {
      log.warn(
        { secretId: doc._id.toHexString() },
        'a project secret cannot be decrypted; its value is not searched for',
      );
    }
  }
  return found;
}

/**
 * Rescan every stored run log and run error. Run it where the runner's environment is loaded,
 * so the values of its CVX_SECRET_* and gateway keys are redacted too, not only known formats;
 * with AUTH_SECRET set, the current values of the project secrets as well.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({ level: config.LOG_LEVEL, name: 'redact' });
  const database = await connectDatabase(config.MONGO_URI);
  try {
    const result = await redactStoredRunLogs(
      database.collections,
      new Redactor([
        ...knownSecretsFromEnv(process.env),
        ...(await projectSecrets(database, config.AUTH_SECRET, log)),
      ]),
      { force: true, onError: (details) => log.error(details, 'stored run log redaction failed') },
    );
    log.info(result, 'stored run logs redacted');
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  const reason = error instanceof StoredRedactionError ? error.message : String(error);
  process.stderr.write(`conclavix redact failed: ${reason}\n`);
  process.exit(1);
});
