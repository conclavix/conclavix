import { randomBytes } from 'node:crypto';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp, type AppOptions } from '../src/app.js';
import { connectDatabase, type Database } from '../src/db.js';
import type { MemoryStore } from '../src/modules/memory/store.js';

export const BOARD_TOKEN = 'test-board-token-0123456789abcdef0123';
export const AUTH_SECRET = 'test-auth-secret-0123456789abcdef0123456789';
export const BOARD_URL = 'http://board.test';

const baseUri = process.env['TEST_MONGO_URI'] ?? 'mongodb://127.0.0.1:27088/?directConnection=true';

/** Select a test database in the configured MongoDB URI while preserving connection options. */
function uriForDatabase(name: string): string {
  const url = new URL(baseUri);
  url.pathname = `/${name}`;
  return url.toString();
}

export interface TestContext {
  app: FastifyInstance;
  database: Database;
  request(options: InjectOptions): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

/**
 * Create a ready test app backed by a randomly named database.
 * Requests default to the test board token; close disposes the app, database, and connection.
 */
export async function createTestContext(
  options: Partial<Omit<AppOptions, 'version' | 'database'>> & {
    webRoot?: string;
    memoryStore?: MemoryStore;
  } = {},
): Promise<TestContext> {
  const database = await connectDatabase(
    uriForDatabase(`cvx_test_${randomBytes(6).toString('hex')}`),
  );
  const app = await buildApp({
    version: 'test',
    database,
    authSecret: AUTH_SECRET,
    boardToken: BOARD_TOKEN,
    boardUrl: BOARD_URL,
    authRateLimit: false,
    ...options,
  });
  return {
    app,
    database,
    /** Inject a request with board authentication unless its headers override the token. */
    request: (options) =>
      app.inject({
        ...options,
        headers: { authorization: `Bearer ${BOARD_TOKEN}`, ...options.headers },
      }),
    /** Close the app, drop its isolated database, and release the database connection. */
    close: async () => {
      await app.close();
      await database.db.dropDatabase();
      await database.close();
    },
  };
}
