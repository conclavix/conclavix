import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOARD_URL, createTestContext, type TestContext } from './helpers.js';
import { asBrowser, createUser, signIn } from './auth-helpers.js';

interface OpenStream {
  status: number;
  /** Resolves true when the server ended the stream within the timeout. */
  endedWithin(ms: number): Promise<boolean>;
  close(): void;
}

async function openStream(baseUrl: string, headers: Record<string, string>): Promise<OpenStream> {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/stream`, {
    headers: { origin: BOARD_URL, ...headers },
    signal: controller.signal,
  });
  let ended = false;
  const done = (async () => {
    if (!response.body) return;
    const reader = response.body.getReader();
    try {
      for (;;) {
        if ((await reader.read()).done) break;
      }
      ended = true;
    } catch {
      return;
    }
  })();
  return {
    status: response.status,
    close: () => controller.abort(),
    endedWithin: async (ms) => {
      await Promise.race([done, new Promise((resolve) => setTimeout(resolve, ms))]);
      return ended;
    },
  };
}

describe('event stream access is re-checked while the stream is open', () => {
  let ctx: TestContext;
  let baseUrl: string;
  const open: OpenStream[] = [];

  const stream = async (headers: Record<string, string>) => {
    const opened = await openStream(baseUrl, headers);
    open.push(opened);
    expect(opened.status).toBe(200);
    return opened;
  };
  const user = async (email: string, role: 'admin' | 'member' | 'viewer' = 'member') => {
    const id = await createUser(ctx, email, role);
    const { cookie } = await signIn(ctx, email);
    return { id, cookie };
  };

  beforeAll(async () => {
    ctx = await createTestContext({
      settingsDefaults: { mfaPolicy: 'optional' },
      // Long enough that only the immediate re-checks can end a stream within these tests.
      streamRecheckMs: 60_000,
    });
    baseUrl = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  });

  afterAll(async () => {
    for (const opened of open) opened.close();
    await ctx.close();
  });

  it('ends a session stream on sign-out but keeps other users streaming', async () => {
    const ada = await user('ada@example.com');
    const bob = await user('bob@example.com');
    const adaStream = await stream({ cookie: ada.cookie });
    const bobStream = await stream({ cookie: bob.cookie });
    const out = await asBrowser(ctx, ada.cookie, { method: 'POST', url: '/api/auth/sign-out' });
    expect(out.statusCode).toBe(200);
    expect(await adaStream.endedWithin(1000)).toBe(true);
    expect(await bobStream.endedWithin(800)).toBe(false);
  });

  it('ends a token stream when that token is revoked', async () => {
    const carl = await user('carl@example.com');
    const created = await asBrowser(ctx, carl.cookie, {
      method: 'POST',
      url: '/api/me/tokens',
      payload: { name: 'script' },
    });
    const tokenStream = await stream({ authorization: `Bearer ${created.json().token}` });
    const sessionStream = await stream({ cookie: carl.cookie });
    const revoked = await asBrowser(ctx, carl.cookie, {
      method: 'DELETE',
      url: `/api/me/tokens/${created.json().id}`,
    });
    expect(revoked.statusCode).toBe(204);
    expect(await tokenStream.endedWithin(1000)).toBe(true);
    expect(await sessionStream.endedWithin(800)).toBe(false);
  });

  it.each(['ban', 'delete', 'reset-password'] as const)(
    'ends every stream of a user on %s',
    async (action) => {
      const dora = await user(`dora-${action}@example.com`);
      const created = await asBrowser(ctx, dora.cookie, {
        method: 'POST',
        url: '/api/me/tokens',
        payload: { name: 'script' },
      });
      const streams = [
        await stream({ cookie: dora.cookie }),
        await stream({ authorization: `Bearer ${created.json().token}` }),
      ];
      const response =
        action === 'delete'
          ? await ctx.request({ method: 'DELETE', url: `/api/users/${dora.id}` })
          : await ctx.request({
              method: 'POST',
              url: `/api/users/${dora.id}/${action}`,
              payload: action === 'reset-password' ? { password: 'brand new password 1' } : {},
            });
      expect(response.statusCode).toBeLessThan(300);
      for (const opened of streams) expect(await opened.endedWithin(1000)).toBe(true);
    },
  );

  it('refuses to reopen a stream after access ended', async () => {
    const fay = await user('fay@example.com');
    await ctx.request({ method: 'POST', url: `/api/users/${fay.id}/ban` });
    const reopened = await openStream(baseUrl, { cookie: fay.cookie });
    open.push(reopened);
    expect(reopened.status).toBe(401);
  });
});

describe('periodic stream re-check', () => {
  it('notices a session that ended elsewhere at the next check', async () => {
    const ctx = await createTestContext({
      settingsDefaults: { mfaPolicy: 'optional' },
      streamRecheckMs: 300,
    });
    const baseUrl = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const id = await createUser(ctx, 'eve@example.com', 'member');
    const { cookie } = await signIn(ctx, 'eve@example.com');
    const opened = await openStream(baseUrl, { cookie });
    try {
      expect(opened.status).toBe(200);
      expect(await opened.endedWithin(700)).toBe(false);
      await ctx.database.collections.sessions.deleteMany({ userId: new ObjectId(id) });
      expect(await opened.endedWithin(2000)).toBe(true);
    } finally {
      opened.close();
      await ctx.close();
    }
  });
});
