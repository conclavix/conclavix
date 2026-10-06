import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { ObjectId } from 'mongodb';
import pino from 'pino';
import type { RunDoc } from '../db.js';
import type { RunDispatcher } from '../modules/scheduler/scheduler.js';
import type { RunWorker } from './run-worker.js';

export const RUN_QUEUE = 'conclavix-runs';

const log = pino({ name: 'queue' });

interface RunJob {
  runId: string;
}

/** Redis connection options as BullMQ needs them for blocking workers. */
export const redisConnection = (url: string): ConnectionOptions => ({
  url,
  maxRetriesPerRequest: null,
});

/**
 * A Redis error without the arguments of the failed command. ioredis attaches them, and for AUTH
 * and HELLO they contain the password.
 */
export function redactRedisError(error: unknown): unknown {
  if (!(error instanceof Error) || !('command' in error)) {
    return error;
  }
  const command = (error as { command?: { name?: unknown } }).command;
  const copy = new Error(error.message);
  copy.name = error.name;
  return Object.assign(copy, { command: { name: command?.name } });
}

/**
 * Log BullMQ errors redacted. Without a listener BullMQ prints them with console.error, including
 * the Redis password when authentication fails.
 */
function logErrors(emitter: { on(event: 'error', listener: (error: Error) => void): unknown }) {
  emitter.on('error', (error) => log.error({ err: redactRedisError(error) }, 'redis queue error'));
}

/** Resolve once Redis answers PING; rejects on the first connection failure without retrying. */
export async function pingRedis(url: string): Promise<void> {
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
  // Without a listener ioredis prints the error; the first one explains why connect() failed.
  let failure: unknown;
  client.on('error', (error) => {
    failure ??= error;
  });
  try {
    await client.connect();
    await client.ping();
  } catch (error) {
    throw redactRedisError(failure ?? error);
  } finally {
    client.disconnect();
  }
}

/** Puts runs on the queue; the run id is the job id, so dispatching twice is harmless. */
export class QueueDispatcher implements RunDispatcher {
  private readonly queue: Queue<RunJob>;

  constructor(connection: ConnectionOptions, prefix?: string) {
    this.queue = new Queue<RunJob>(RUN_QUEUE, { connection, ...(prefix ? { prefix } : {}) });
    logErrors(this.queue);
  }

  async dispatch(run: RunDoc): Promise<void> {
    const runId = run._id.toHexString();
    const existing = await this.queue.getJob(runId);
    const state = await existing?.getState();
    if (state === 'completed' || state === 'failed') {
      await existing?.remove();
    }
    await this.queue.add(
      'run',
      { runId },
      { jobId: runId, removeOnComplete: 1000, removeOnFail: 1000 },
    );
  }

  close(): Promise<void> {
    return this.queue.close();
  }
}

/** Consume runs from the queue with a fixed number of runs in parallel. */
export function startQueueWorker(
  connection: ConnectionOptions,
  runWorker: RunWorker,
  concurrency: number,
  prefix?: string,
): Worker<RunJob> {
  const worker = new Worker<RunJob>(
    RUN_QUEUE,
    async (job) => {
      await runWorker.process(new ObjectId(job.data.runId));
    },
    { connection, concurrency, ...(prefix ? { prefix } : {}) },
  );
  logErrors(worker);
  return worker;
}
