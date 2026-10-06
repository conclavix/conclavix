import { loadConfig } from '@conclavix/core';
import pino from 'pino';
import { connectDatabase } from './db.js';
import { StoredRedactionError, redactStoredRunLogs } from './modules/runs/redact-stored.js';
import { Redactor } from './runner/redact.js';
import { knownSecretsFromEnv } from './runner/secrets.js';

/**
 * Rescan every stored run log and run error. Run it where the runner's environment is loaded,
 * so the values of its CVX_SECRET_* and gateway keys are redacted too, not only known formats.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({ level: config.LOG_LEVEL, name: 'redact' });
  const database = await connectDatabase(config.MONGO_URI);
  try {
    const result = await redactStoredRunLogs(
      database.collections,
      new Redactor(knownSecretsFromEnv(process.env)),
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
