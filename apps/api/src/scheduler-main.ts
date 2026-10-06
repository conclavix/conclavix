import { credentialWarnings, loadConfig } from '@conclavix/core';
import pino from 'pino';
import { connectDatabase } from './db.js';
import { Scheduler } from './modules/scheduler/scheduler.js';
import { QueueDispatcher, redisConnection } from './runner/queue.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({ level: config.LOG_LEVEL, name: 'scheduler' });
  for (const warning of credentialWarnings(config)) log.warn(warning);
  const database = await connectDatabase(config.MONGO_URI);
  const dispatcher = new QueueDispatcher(redisConnection(config.REDIS_URL));
  const scheduler = new Scheduler(database, dispatcher, {
    heartbeatMinutes: config.HEARTBEAT_MINUTES,
    loopThreshold: 3,
    batchSize: 100,
  });
  const maxRunningMs = (config.RUN_TIMEOUT_MINUTES + 5) * 60_000;
  let lastSweep = 0;
  let stopping = false;

  const tick = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastSweep >= 60_000) {
      lastSweep = now;
      const heartbeats = await scheduler.sweepHeartbeats();
      const recovered = await scheduler.recoverRuns(maxRunningMs);
      log.debug({ heartbeats, ...recovered }, 'sweep');
    }
    const counts = await scheduler.processPendingWakes();
    if (counts.run + counts.skip > 0) {
      log.info(counts, 'wakes processed');
    }
  };

  const loop = async (): Promise<void> => {
    while (!stopping) {
      await tick().catch((error: unknown) => log.error({ err: error }, 'scheduler tick failed'));
      await new Promise((resolve) => setTimeout(resolve, config.SCHEDULER_TICK_MS));
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      log.info({ signal }, 'shutting down');
      stopping = true;
    });
  }
  log.info('scheduler started');
  await loop();
  await dispatcher.close();
  await database.close();
}

main().catch((error: unknown) => {
  process.stderr.write(`conclavix scheduler failed: ${String(error)}\n`);
  process.exit(1);
});
