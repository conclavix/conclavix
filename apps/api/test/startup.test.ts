import { createServer, type Server } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { pingRedis } from '../src/runner/queue.js';
import { DependencyUnavailableError, waitForDependency } from '../src/startup.js';

const REDIS = process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6390';

/** A clock that only advances when the waiter sleeps, so backoff is observable without delays. */
function fakeClock() {
  let time = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      time += ms;
    },
  };
}

const quietLog = () => ({ info: vi.fn(), warn: vi.fn() });

/** Accepts TCP connections and closes them at once, as a published Docker port does before its container listens. */
async function closingServer(): Promise<{ url: string; server: Server }> {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP address');
  return { url: `redis://127.0.0.1:${address.port}`, server };
}

describe('waitForDependency', () => {
  it('retries with capped exponential backoff until the dependency answers', async () => {
    const clock = fakeClock();
    const log = quietLog();
    const attempt = vi.fn(async () => {
      if (attempt.mock.calls.length < 8) throw new Error('connection closed');
      return 'db';
    });
    const result = await waitForDependency('mongodb', attempt, {
      maxWaitMs: 120_000,
      log,
      ...clock,
    });
    expect(result).toBe('db');
    expect(clock.sleeps).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000]);
    expect(log.warn).toHaveBeenCalledTimes(7);
    expect(log.warn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ dependency: 'mongodb', attempt: 1, retryInMs: 500 }),
      'dependency not reachable yet, retrying',
    );
    expect(log.info).toHaveBeenCalledWith(
      { dependency: 'mongodb', attempts: 8, waitedMs: 35_500 },
      'dependency reachable',
    );
  });

  it('gives up with a clear error once the wait budget is spent', async () => {
    const clock = fakeClock();
    const attempt = vi.fn(async () => {
      throw new Error('connection closed');
    });
    const failure = waitForDependency('mongodb', attempt, {
      maxWaitMs: 5000,
      log: quietLog(),
      ...clock,
    });
    await expect(failure).rejects.toThrow(DependencyUnavailableError);
    await expect(failure).rejects.toThrow(
      'mongodb not reachable after 5 attempt(s) in 5s: connection closed',
    );
    expect(clock.sleeps).toEqual([500, 1000, 2000, 1500]);
  });

  it('makes exactly one attempt without a wait budget', async () => {
    const clock = fakeClock();
    const attempt = vi.fn(async () => {
      throw new Error('refused');
    });
    await expect(
      waitForDependency('redis', attempt, { maxWaitMs: 0, log: quietLog(), ...clock }),
    ).rejects.toThrow('redis not reachable after 1 attempt(s) in 0s: refused');
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([]);
  });
});

describe('pingRedis', () => {
  it('resolves against a running Redis', async () => {
    await expect(pingRedis(REDIS)).resolves.toBeUndefined();
  });

  it('rejects promptly when the port accepts but closes connections', async () => {
    const { url, server } = await closingServer();
    try {
      const startedAt = Date.now();
      await expect(pingRedis(url)).rejects.toThrow();
      expect(Date.now() - startedAt).toBeLessThan(2000);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
