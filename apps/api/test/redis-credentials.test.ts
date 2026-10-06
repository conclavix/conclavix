import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  pingRedis,
  QueueDispatcher,
  redactRedisError,
  redisConnection,
} from '../src/runner/queue.js';

const logged = vi.hoisted(() => [] as unknown[]);
vi.mock('pino', () => ({
  default: () => ({
    error: (...args: unknown[]) => logged.push(args),
    warn: () => undefined,
    info: () => undefined,
  }),
}));

const REDIS = process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6390';
const PASSWORD = 'sentinel-password-4f1c9e';

/** The test Redis with a user that does not exist, so authentication fails with WRONGPASS. */
function wrongCredentials(): string {
  const url = new URL(REDIS);
  url.username = 'cvx-no-such-user';
  url.password = PASSWORD;
  return url.toString();
}

describe('redis credentials', () => {
  afterEach(() => vi.restoreAllMocks());

  it('removes command arguments from redis errors', () => {
    const error = Object.assign(new Error('WRONGPASS invalid username-password pair'), {
      command: { name: 'hello', args: ['3', 'AUTH', 'user', PASSWORD] },
    });
    const redacted = redactRedisError(error);
    expect(JSON.stringify(redacted)).not.toContain(PASSWORD);
    expect(redacted).toMatchObject({
      message: 'WRONGPASS invalid username-password pair',
      command: { name: 'hello' },
    });
    const plain = new Error('plain');
    expect(redactRedisError(plain)).toBe(plain);
  });

  it('reports a failed login at startup without the password', async () => {
    const failure = await pingRedis(wrongCredentials()).then(
      () => null,
      (error: unknown) => error,
    );
    expect(String(failure)).toContain('WRONGPASS');
    expect(JSON.stringify(failure)).not.toContain(PASSWORD);
    expect(String((failure as Error).stack)).not.toContain(PASSWORD);
  });

  it('logs a failed queue login redacted instead of printing it', async () => {
    const printed: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => printed.push(args));
    logged.length = 0;
    const dispatcher = new QueueDispatcher(redisConnection(wrongCredentials()));
    try {
      await vi.waitFor(
        () => expect(inspect([...logged, ...printed], { depth: 5 })).toContain('WRONGPASS'),
        { timeout: 8000 },
      );
    } finally {
      await dispatcher.close().catch(() => undefined);
    }
    expect(inspect(printed, { depth: 5 })).not.toContain(PASSWORD);
    expect(printed).toEqual([]);
    expect(inspect(logged, { depth: 5 })).not.toContain(PASSWORD);
  }, 15_000);
});
