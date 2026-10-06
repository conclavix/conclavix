import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { MemoryDirectoryCache, RedisDirectoryCache } from '../src/modules/skill-sources/cache.js';

const REDIS = process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6390';
const log = pino({ level: 'silent' });

describe('skill directory cache', () => {
  it('expires entries in memory', async () => {
    const cache = new MemoryDirectoryCache();
    await cache.set('a', '1', 60);
    await cache.set('b', '2', -1);
    expect(await cache.get('a')).toBe('1');
    expect(await cache.get('b')).toBeNull();
    await cache.close();
  });

  it('stores entries in Redis with a TTL', async () => {
    const cache = new RedisDirectoryCache(REDIS, log);
    const key = `test:${Date.now()}`;
    await cache.set(key, 'value', 30);
    expect(await cache.get(key)).toBe('value');
    expect(await cache.get(`${key}:missing`)).toBeNull();
    await cache.close();
  });

  it('reads as a miss when Redis is unreachable', async () => {
    const cache = new RedisDirectoryCache('redis://127.0.0.1:9', log);
    await cache.set('k', 'v', 30);
    expect(await cache.get('k')).toBeNull();
    await cache.close();
  });
});
