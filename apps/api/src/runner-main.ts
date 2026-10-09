import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { credentialWarnings, loadConfig, type Config } from '@conclavix/core';
import pino, { type Logger } from 'pino';
import { connectDatabase, type Database } from './db.js';
import { Scheduler } from './modules/scheduler/scheduler.js';
import { agentRunAs, ClaudeCliAdapter, claudeEnvFrom } from './runner/adapters/claude-cli.js';
import { pingRedis, QueueDispatcher, redisConnection, startQueueWorker } from './runner/queue.js';
import { RunWorker } from './runner/run-worker.js';
import { CodeRuns } from './runner/code-run.js';
import { AuditLog } from './modules/audit/audit.js';
import { releaseClone, type SandboxOptions } from './runner/adapters/sandbox.js';
import { knownSecretsFromEnv, secretsFromEnv } from './runner/secrets.js';
import { vaultBox } from './modules/settings/secret-box.js';
import { waitForDependency } from './startup.js';

/** Longest single git call when committing and syncing after a coding run. */
const COMMIT_GIT_TIMEOUT_MS = 60_000;

/** The sandbox options and the code-run service, when coding agents are configured. */
async function codingAgents(
  config: Config,
  hasAgentUser: boolean,
  database: Database,
  log: Logger,
): Promise<{ sandbox?: SandboxOptions; codeRuns?: CodeRuns }> {
  const helper = config.AGENT_SANDBOX_HELPER;
  if (!helper) return {};
  if (!hasAgentUser) {
    log.warn('AGENT_SANDBOX_HELPER needs AGENT_USER; coding agents stay disabled');
    return {};
  }
  const { CodeWorkspace } = await import('./modules/workspace/commit.js');
  const workspace = new CodeWorkspace(resolve(config.WORKSPACE_ROOT), {
    gitBin: config.GIT_BIN,
    agentEmailDomain: config.AGENT_EMAIL_DOMAIN,
    limits: { archiveTimeoutMs: COMMIT_GIT_TIMEOUT_MS },
  });
  log.info({ helper, workspaceRoot: workspace.root }, 'coding agents enabled');
  return {
    sandbox: {
      helper,
      sudo: config.SUDO_BIN,
      limits: {
        memoryMax: config.CODE_RUN_MEMORY_MAX,
        cpuQuotaPercent: config.CODE_RUN_CPU_QUOTA,
        tasksMax: config.CODE_RUN_TASKS_MAX,
        diskLimitMb: config.CODE_RUN_DISK_LIMIT_MB,
      },
      extraDomains: config.CODE_SANDBOX_DOMAINS,
    },
    codeRuns: new CodeRuns(
      database,
      new AuditLog(database.collections, log),
      workspace,
      (projectId, issueKey) => releaseClone({ helper, sudo: config.SUDO_BIN }, projectId, issueKey),
    ),
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (process.getuid?.() === 0) {
    throw new Error('refusing to run agents as root; start the runner as a dedicated user');
  }
  const log = pino({ level: config.LOG_LEVEL, name: 'runner' });
  for (const warning of credentialWarnings(config)) log.warn(warning);
  const runAs = agentRunAs(config.AGENT_USER, config.SUDO_BIN, userInfo().username);
  if (!runAs) {
    log.warn('AGENT_USER is not set; agents run as the runner user and can read its secrets');
  }
  const wait = { maxWaitMs: config.STARTUP_WAIT_SECONDS * 1000, log };
  await waitForDependency('redis', () => pingRedis(config.REDIS_URL), wait);
  const database = await waitForDependency(
    'mongodb',
    () => connectDatabase(config.MONGO_URI),
    wait,
  );
  const connection = redisConnection(config.REDIS_URL);
  const dispatcher = new QueueDispatcher(connection);
  const scheduler = new Scheduler(database, dispatcher);
  const { sandbox, codeRuns } = await codingAgents(config, runAs !== undefined, database, log);
  const runWorker = new RunWorker(database, scheduler, {
    ...(codeRuns ? { codeRuns } : {}),
    // Without AUTH_SECRET, runs of agents that have project secrets fail with an explanation.
    secretBox: config.AUTH_SECRET ? vaultBox(config.AUTH_SECRET) : null,
    audit: new AuditLog(database.collections, log),
    workspacesRoot: resolve(config.WORKSPACES_ROOT),
    mcpUrl: new URL('/mcp', config.PUBLIC_API_URL).toString(),
    timeoutMs: config.RUN_TIMEOUT_MINUTES * 60_000,
    knownSecrets: knownSecretsFromEnv(process.env),
    adapters: {
      claude_cli: new ClaudeCliAdapter({
        bin: config.CLAUDE_BIN,
        extraEnv: claudeEnvFrom(process.env),
        secrets: secretsFromEnv(process.env),
        ...(runAs ? { runAs } : {}),
        ...(sandbox ? { sandbox } : {}),
      }),
    },
  });
  const worker = startQueueWorker(connection, runWorker, config.RUNNER_CONCURRENCY);
  worker.on('failed', (job, error) =>
    log.error({ runId: job?.data.runId, err: error }, 'run job failed'),
  );
  worker.on('completed', (job) => log.info({ runId: job.data.runId }, 'run job completed'));

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      log.info({ signal }, 'shutting down after current runs');
      void worker
        .close()
        .then(() => dispatcher.close())
        .then(() => database.close())
        .then(() => process.exit(0))
        .catch((error: unknown) => {
          log.error({ err: error }, 'runner shutdown failed');
          process.exit(1);
        });
    });
  }
  log.info(
    { concurrency: config.RUNNER_CONCURRENCY, agentUser: runAs?.user ?? null },
    'runner started',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`conclavix runner failed: ${String(error)}\n`);
  process.exit(1);
});
