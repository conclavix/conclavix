import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerAuthRoutes } from '../src/modules/auth/routes.js';
import type { Auth } from '../src/modules/auth/better-auth.js';
import type { AuditLog } from '../src/modules/audit/audit.js';
import { StreamConnections } from '../src/modules/stream/connections.js';

describe('auth audit boundaries', () => {
  it.each([
    [{ email: ' ADA@EXAMPLE.COM ' }, '{"user":{"id":"123"}}', { email: 'ada@example.com' }, '123'],
    [{ email: 42 }, '{"user":{"id":42}}', {}, null],
    [{ email: 'not an email' }, '{"user":null}', {}, null],
    [[], 'null', {}, null],
    [{}, 'redirect response', {}, null],
  ])(
    'validates request and response data before auditing',
    async (body, response, details, targetUserId) => {
      const app = Fastify();
      const record = vi.fn();
      const auth = { handler: async () => new Response(response as string) } as unknown as Auth;
      registerAuthRoutes(
        app,
        auth,
        'http://board.test',
        { record } as unknown as AuditLog,
        new StreamConnections(),
      );
      try {
        const result = await app.inject({
          method: 'POST',
          url: '/api/auth/sign-in/email',
          payload: body,
        });
        expect(result.statusCode).toBe(200);
        expect(record).toHaveBeenCalledWith(expect.objectContaining({ details, targetUserId }));
      } finally {
        await app.close();
      }
    },
  );
});
