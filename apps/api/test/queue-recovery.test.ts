import { Queue, Worker } from 'bullmq';
import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import type { RunDoc } from '../src/db.js';
import { QueueDispatcher, redisConnection, RUN_QUEUE } from '../src/runner/queue.js';

describe('queue recovery', () => {
  it.each(['completed', 'failed'] as const)(
    'replaces a %s job before redispatching',
    async (terminalState) => {
      const connection = redisConnection(process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6390');
      const prefix = `cvx-recovery-${new ObjectId().toHexString()}`;
      const queue = new Queue(RUN_QUEUE, { connection, prefix });
      const dispatcher = new QueueDispatcher(connection, prefix);
      const worker = new Worker(
        RUN_QUEUE,
        async () => {
          if (terminalState === 'failed') throw new Error('previous attempt failed');
        },
        { connection, prefix },
      );
      const run = { _id: new ObjectId() } as RunDoc;
      const runId = run._id.toHexString();
      try {
        await dispatcher.dispatch(run);
        await expect.poll(async () => (await queue.getJob(runId))?.getState()).toBe(terminalState);
        await worker.close();
        await dispatcher.dispatch(run);
        const replacement = await queue.getJob(runId);
        expect(await replacement?.getState()).toBe('waiting');
        expect(replacement?.attemptsMade).toBe(0);
        await dispatcher.dispatch(run);
        expect(await queue.getJobCounts('wait')).toMatchObject({ wait: 1 });
      } finally {
        await worker.close();
        await queue.obliterate({ force: true });
        await dispatcher.close();
        await queue.close();
      }
    },
  );
});
