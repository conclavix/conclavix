import { credentialWarnings, loadConfig, requireAuthSecret, type Config } from '@conclavix/core';
import { buildApp } from './app.js';
import { connectDatabase } from './db.js';
import { serializeRequest } from './modules/auth/redact.js';
import { settingsDefaults } from './modules/settings/defaults.js';
import { HindsightClient } from './modules/memory/hindsight-client.js';
import { HindsightMemoryStore } from './modules/memory/hindsight-store.js';
import { startStoredRunLogRedaction } from './modules/runs/redact-stored.js';
import { Redactor } from './runner/redact.js';
import { Workspace } from './modules/workspace/service.js';
import { RedisDirectoryCache } from './modules/skill-sources/cache.js';
import { knownSecretsFromEnv } from './runner/secrets.js';

function hindsightStore(config: Config): HindsightMemoryStore {
  if (!config.HINDSIGHT_URL) {
    throw new Error('MEMORY_BACKEND=hindsight needs HINDSIGHT_URL');
  }
  return new HindsightMemoryStore(
    new HindsightClient({
      baseUrl: config.HINDSIGHT_URL,
      bank: config.HINDSIGHT_BANK,
      ...(config.HINDSIGHT_API_KEY ? { apiKey: config.HINDSIGHT_API_KEY } : {}),
    }),
  );
}

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/** Load configuration, connect the database, and start the API with signal-driven shutdown. */
async function main(): Promise<void> {
  const config = loadConfig();
  const authSecret = requireAuthSecret(config);
  const database = await connectDatabase(config.MONGO_URI);
  const workspace = new Workspace(config.WORKSPACE_ROOT, { gitBin: config.GIT_BIN });
  const app = await buildApp({
    version: process.env['npm_package_version'] ?? '0.0.0',
    database,
    authSecret,
    ...(config.BOARD_TOKEN ? { boardToken: config.BOARD_TOKEN } : {}),
    boardUrl: config.BOARD_URL ?? config.PUBLIC_API_URL,
    sessionTtlHours: config.SESSION_TTL_HOURS,
    settingsDefaults: settingsDefaults(config),
    ...(config.WEB_ROOT ? { webRoot: config.WEB_ROOT } : {}),
    ...(config.MEMORY_BACKEND === 'hindsight' ? { memoryStore: hindsightStore(config) } : {}),
    createDirectoryCache: (log) => new RedisDirectoryCache(config.REDIS_URL, log),
    skillSourcesAllowPrivate: config.SKILL_SOURCES_ALLOW_PRIVATE,
    workspace,
    logger: { level: config.LOG_LEVEL, serializers: { req: serializeRequest } },
  });
  if (config.SKILL_SOURCES_ALLOW_PRIVATE) {
    app.log.warn(
      'SKILL_SOURCES_ALLOW_PRIVATE is set: skill directories may use http and private addresses',
    );
  }
  for (const warning of credentialWarnings({ MONGO_URI: config.MONGO_URI })) app.log.warn(warning);

  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => {
      app.log.info({ signal }, 'shutting down');
      app
        .close()
        .finally(() => database.close())
        .then(
          () => process.exit(0),
          (error: unknown) => {
            app.log.error({ err: error }, 'shutdown failed');
            process.exit(1);
          },
        );
    });
  }

  await app.listen({ host: config.HOST, port: config.PORT });
  workspace.checkGit().then(
    (version) => app.log.info({ git: version, root: workspace.root }, 'project workspace ready'),
    (error: unknown) =>
      app.log.warn({ err: error }, 'git is unusable; the project code routes will fail'),
  );

  const redactor = new Redactor(knownSecretsFromEnv(process.env));
  void startStoredRunLogRedaction(database.collections, redactor, app.log);
}

main().catch((error: unknown) => {
  process.stderr.write(`conclavix api failed to start: ${String(error)}\n`);
  process.exit(1);
});
