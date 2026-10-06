import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redactUrl } from '../src/modules/auth/redact.js';
import { BOARD_URL, createTestContext, type TestContext } from './helpers.js';
import { asBrowser, createUser, signIn } from './auth-helpers.js';

describe('password reset by e-mail', () => {
  let ctx: TestContext;
  const lines: string[] = [];

  beforeAll(async () => {
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    ctx = await createTestContext({
      logger: { level: 'warn', stream },
      settingsDefaults: { mfaPolicy: 'optional' },
    });
    await createUser(ctx, 'reset@example.com', 'member');
  });

  afterAll(async () => {
    await ctx.close();
  });

  const request = (email: string) =>
    asBrowser(ctx, '', {
      method: 'POST',
      url: '/api/auth/request-password-reset',
      payload: { email, redirectTo: `${BOARD_URL}/reset-password` },
    });

  it('answers the same for known and unknown addresses', async () => {
    const known = await request('reset@example.com');
    const unknown = await request('nobody@example.com');
    expect(known.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json()).toEqual(known.json());
  });

  it('warns loudly without SMTP and never logs the reset link', async () => {
    const warning = lines.find((line) => line.includes('SMTP is not configured'));
    expect(warning).toContain('***@example.com');
    expect(warning).not.toContain('reset@example.com');
    expect(lines.join('\n')).not.toContain('/reset-password/');
  });

  it('resets through the token path segment and the new password works', async () => {
    const verification = await ctx.database.db
      .collection('verification')
      .findOne({ identifier: { $regex: '^reset-password:' } });
    const token = String(verification?.['identifier']).slice('reset-password:'.length);
    const link = await asBrowser(ctx, '', {
      method: 'GET',
      url: `/api/auth/reset-password/${token}?callbackURL=${encodeURIComponent(`${BOARD_URL}/reset-password`)}`,
    });
    expect(link.statusCode).toBe(302);
    expect(link.headers.location).toBe(`${BOARD_URL}/reset-password?token=${token}`);
    const reset = await asBrowser(ctx, '', {
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, newPassword: 'the new password 42' },
    });
    expect(reset.statusCode).toBe(200);
    expect(
      (await signIn(ctx, 'reset@example.com', 'the new password 42')).response.statusCode,
    ).toBe(200);
    const legacy = await asBrowser(ctx, '', {
      method: 'POST',
      url: '/api/auth/forget-password',
      payload: { email: 'reset@example.com' },
    });
    expect(legacy.statusCode).toBe(404);
  });

  it('redacts reset tokens from logged URLs', () => {
    expect(redactUrl('/api/auth/reset-password/abc123?callbackURL=x')).toBe(
      '/api/auth/reset-password/[redacted]?callbackURL=x',
    );
    expect(redactUrl('/reset-password?token=abc&x=1')).toBe('/reset-password?token=[redacted]&x=1');
  });
});
