import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOARD_URL, createTestContext, type TestContext } from './helpers.js';
import { cookiesOf, createUser, PASSWORD, signIn } from './auth-helpers.js';

describe('origin check for cookie-authenticated board requests', () => {
  let ctx: TestContext;
  let ownerCookie: string;
  let victimId: string;
  let personalToken: string;

  /** A request with the owner's session cookie and exactly the given headers, nothing else. */
  const withCookie = (options: InjectOptions & { headers?: Record<string, string> }) =>
    ctx.app.inject({ ...options, headers: { cookie: ownerCookie, ...options.headers } });

  const banned = async (): Promise<boolean> => {
    const user = await ctx.database.collections.users.findOne({ email: 'victim@example.com' });
    return user?.banned === true;
  };

  beforeAll(async () => {
    ctx = await createTestContext({ settingsDefaults: { mfaPolicy: 'optional' } });
    await createUser(ctx, 'owner@example.com', 'owner');
    victimId = await createUser(ctx, 'victim@example.com', 'member');
    ownerCookie = (await signIn(ctx, 'owner@example.com')).cookie;
    expect(ownerCookie).not.toBe('');
    const token = await withCookie({
      method: 'POST',
      url: '/api/me/tokens',
      headers: { origin: BOARD_URL },
      payload: { name: 'script' },
    });
    expect(token.statusCode).toBe(201);
    personalToken = token.json().token as string;
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('allows a state-changing request from the board origin', async () => {
    const response = await withCookie({
      method: 'POST',
      url: '/api/projects',
      headers: { origin: BOARD_URL, 'sec-fetch-site': 'same-origin' },
      payload: { key: 'OK', name: 'From the board' },
    });
    expect(response.statusCode).toBe(201);
  });

  it('accepts the Referer origin when Origin is absent', async () => {
    const response = await withCookie({
      method: 'POST',
      url: '/api/projects',
      headers: { referer: `${BOARD_URL}/projects?tab=1` },
      payload: { key: 'REF', name: 'Via referer' },
    });
    expect(response.statusCode).toBe(201);
  });

  it.each([
    ['another origin', { origin: 'https://evil.example' }],
    ['a sibling subdomain', { origin: 'http://evil.board.test' }],
    ['another port', { origin: 'http://board.test:8080' }],
    ['another scheme', { origin: 'https://board.test' }],
    ['an opaque origin', { origin: 'null' }],
    ['neither Origin nor Referer', {}],
    ['a Referer from another origin', { referer: 'http://evil.board.test/attack' }],
    ['an unparsable Referer', { referer: 'not a url' }],
    ['Sec-Fetch-Site same-site', { origin: BOARD_URL, 'sec-fetch-site': 'same-site' }],
    ['Sec-Fetch-Site cross-site', { origin: BOARD_URL, 'sec-fetch-site': 'cross-site' }],
    ['Sec-Fetch-Site none', { origin: BOARD_URL, 'sec-fetch-site': 'none' }],
  ])('rejects a body-less ban with %s', async (_label, headers: Record<string, string>) => {
    const response = await withCookie({
      method: 'POST',
      url: `/api/users/${victimId}/ban`,
      headers,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'csrf_origin_mismatch' });
    expect(await banned()).toBe(false);
  });

  it.each([
    ['PUT', '/api/org/lead'],
    ['PATCH', '/api/users/:id'],
    ['DELETE', '/api/users/:id'],
  ] as const)('checks %s %s as well', async (method, url) => {
    const response = await withCookie({
      method,
      url: url.replace(':id', victimId),
      headers: { origin: 'http://evil.board.test' },
      payload: { name: 'renamed' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'csrf_origin_mismatch' });
    const victim = await ctx.database.collections.users.findOne({ email: 'victim@example.com' });
    expect(victim?.name).toBe('victim');
  });

  it('leaves safe methods alone', async () => {
    const response = await withCookie({ method: 'GET', url: '/api/projects' });
    expect(response.statusCode).toBe(200);
    const evil = await withCookie({
      method: 'GET',
      url: '/api/me',
      headers: { origin: 'http://evil.board.test', 'sec-fetch-site': 'same-site' },
    });
    expect(evil.statusCode).toBe(200);
  });

  it('does not apply to bearer clients, which carry no ambient credential', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: `Bearer ${personalToken}` },
      payload: { key: 'PAT', name: 'By token' },
    });
    expect(response.statusCode).toBe(201);
    const boardToken = await ctx.request({
      method: 'POST',
      url: '/api/projects',
      headers: { origin: 'http://evil.board.test' },
      payload: { key: 'BRK', name: 'Break glass' },
    });
    expect(boardToken.statusCode).toBe(201);
  });

  it('exempts a bearer request even when the browser also attaches the cookie', async () => {
    const response = await withCookie({
      method: 'POST',
      url: '/api/projects',
      headers: {
        authorization: `Bearer ${personalToken}`,
        origin: 'http://evil.board.test',
        'sec-fetch-site': 'same-site',
      },
      payload: { key: 'MIX', name: 'Token and cookie' },
    });
    expect(response.statusCode).toBe(201);
  });

  it('does not let a bearer header exempt the cookie-only better-auth routes', async () => {
    const response = await withCookie({
      method: 'POST',
      url: '/api/auth/revoke-other-sessions',
      headers: { authorization: `Bearer ${personalToken}`, origin: 'http://evil.board.test' },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'csrf_origin_mismatch' });
  });

  it('does not touch /mcp, which authenticates with run tokens', async () => {
    const response = await withCookie({
      method: 'POST',
      url: '/mcp',
      headers: { origin: 'http://evil.board.test' },
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('guards the better-auth routes with the session cookie too', async () => {
    const response = await withCookie({
      method: 'POST',
      url: '/api/auth/revoke-other-sessions',
      headers: { origin: BOARD_URL, 'sec-fetch-site': 'same-site' },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'csrf_origin_mismatch' });
  });

  it('blocks a login CSRF from a sibling subdomain but keeps cookie-less API sign-in', async () => {
    const forged = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { origin: 'http://evil.board.test', 'sec-fetch-site': 'same-site' },
      payload: { email: 'owner@example.com', password: PASSWORD },
    });
    expect(forged.statusCode).toBe(403);
    expect(forged.json()).toMatchObject({ error: 'csrf_origin_mismatch' });
    expect(cookiesOf(forged)).toBe('');

    const scripted = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'owner@example.com', password: PASSWORD },
    });
    expect(scripted.statusCode).toBe(200);
  });
});
