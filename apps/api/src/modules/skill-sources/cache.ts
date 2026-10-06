import type { FastifyBaseLogger } from 'fastify';
import { Redis } from 'ioredis';
import { redactRedisError } from '../../runner/queue.js';

/**
 * A short-lived cache for directory answers, so browsing does not spend the provider's daily
 * request budget twice on the same page. It is best effort: a failing cache reads as a miss.
 */
export interface DirectoryCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  close(): Promise<void>;
}

const MEMORY_ENTRIES = 500;

/** In-process cache for tests and as a fallback; evicts the oldest entry beyond its size. */
export class MemoryDirectoryCache implements DirectoryCache {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    while (this.entries.size > MEMORY_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  async close(): Promise<void> {
    this.entries.clear();
  }
}

const KEY_PREFIX = 'conclavix:skilldir:';
const ERROR_LOG_INTERVAL_MS = 60_000;
const COMMAND_TIMEOUT_MS = 500;

/** Redis-backed cache shared by API processes; Redis being down only costs cache hits. */
export class RedisDirectoryCache implements DirectoryCache {
  private readonly client: Redis;
  private lastErrorLog = 0;

  constructor(
    url: string,
    private readonly log: FastifyBaseLogger,
  ) {
    this.client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      commandTimeout: COMMAND_TIMEOUT_MS,
      retryStrategy: (times) => Math.min(times * 500, 10_000),
    });
    this.client.on('error', (error) => this.logError(error));
    this.client.connect().catch((error: unknown) => this.logError(error));
  }

  private logError(error: unknown): void {
    if (Date.now() - this.lastErrorLog < ERROR_LOG_INTERVAL_MS) return;
    this.lastErrorLog = Date.now();
    this.log.warn({ err: redactRedisError(error) }, 'skill directory cache unavailable');
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(KEY_PREFIX + key);
    } catch (error) {
      this.logError(error);
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(KEY_PREFIX + key, value, 'EX', Math.max(1, Math.ceil(ttlSeconds)));
    } catch (error) {
      this.logError(error);
    }
  }

  async close(): Promise<void> {
    this.client.disconnect();
  }
}
