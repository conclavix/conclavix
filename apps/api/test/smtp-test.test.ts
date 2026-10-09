import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SmtpSettings } from '../src/modules/settings/service.js';
import {
  AttemptLimiter,
  classifySmtpError,
  mergeSmtp,
  sanitizeSmtpText,
} from '../src/modules/settings/smtp-test.js';
import { createTestContext, type TestContext } from './helpers.js';
import { asBrowser, createUser, signIn } from './auth-helpers.js';
import { closedPort, startFakeSmtp, type FakeSmtp } from './fake-smtp.js';

const STORED_PASS = 'stored-smtp-secret-42';
const STORED: SmtpSettings = {
  host: 'smtp.stored',
  port: 587,
  secure: false,
  user: 'mailer',
  pass: STORED_PASS,
  from: 'board@example.com',
};

describe('SMTP test helpers', () => {
  it('lays unsaved values over the stored ones and keeps the password write-only', () => {
    expect(mergeSmtp(STORED, undefined)).toEqual(STORED);
    expect(mergeSmtp(STORED, { host: 'smtp.new', pass: '' })).toEqual({
      ...STORED,
      host: 'smtp.new',
    });
    expect(mergeSmtp(STORED, { pass: 'typed' }).pass).toBe('typed');
    expect(mergeSmtp(STORED, { pass: null }).pass).toBeNull();
  });

  it.each([
    [{ code: 'EAUTH', command: 'AUTH PLAIN' }, 'auth'],
    [{ code: 'ENOAUTH' }, 'auth'],
    [{ code: 'ETLS' }, 'tls'],
    [{ code: 'ESOCKET', message: 'self-signed certificate in certificate chain' }, 'tls'],
    [{ code: 'ECONNECTION', message: 'connect ECONNREFUSED 127.0.0.1:1' }, 'connection'],
    [{ code: 'ETIMEDOUT', message: 'Greeting never received' }, 'connection'],
    [{ code: 'EENVELOPE', command: 'MAIL FROM' }, 'sender'],
    [{ code: 'EENVELOPE', command: 'RCPT TO' }, 'recipient'],
    [{ code: 'EMESSAGE', command: 'DATA' }, 'message'],
    [new Error('boom'), 'unknown'],
    [null, 'unknown'],
  ])('classifies %o as %s', (error, kind) => {
    expect(classifySmtpError(error)).toBe(kind);
  });

  it('removes the password in every encoding and control characters from server text', () => {
    const plain = Buffer.from(`\u0000mailer\u0000${STORED_PASS}`).toString('base64');
    const text = `535 bad ${STORED_PASS} / ${plain} / ${Buffer.from(STORED_PASS).toString('base64')}\r\nnext`;
    const clean = sanitizeSmtpText(text, STORED);
    expect(clean).toBe('535 bad *** / *** / *** next');
    expect(sanitizeSmtpText('x'.repeat(400), STORED)).toHaveLength(303);
    expect(sanitizeSmtpText('', STORED)).toBeNull();
    expect(sanitizeSmtpText(undefined, STORED)).toBeNull();
  });

  it('allows a number of attempts per key and window, then tells how long to wait', () => {
    let now = 0;
    const limiter = new AttemptLimiter(2, 60_000, () => now);
    expect(limiter.take('a')).toBeNull();
    expect(limiter.take('a')).toBeNull();
    expect(limiter.take('b')).toBeNull();
    now = 15_000;
    expect(limiter.take('a')).toBe(45);
    now = 60_000;
    expect(limiter.take('a')).toBeNull();
  });
});

describe('POST /api/settings/smtp/test', () => {
  let ctx: TestContext;
  let smtp: FakeSmtp;
  let other: FakeSmtp;
  let ownerCookie: string;
  let adminCookie: string;

  const asOwner = (payload: object = {}) =>
    asBrowser(ctx, ownerCookie, { method: 'POST', url: '/api/settings/smtp/test', payload });
  const asBoard = (payload: object = {}) =>
    ctx.request({ method: 'POST', url: '/api/settings/smtp/test', payload });

  beforeAll(async () => {
    smtp = await startFakeSmtp({
      credentials: { user: 'mailer', pass: STORED_PASS },
      echoAuth: true,
      rejectRecipients: ['nobody@example.com'],
    });
    other = await startFakeSmtp({ rejectSender: true });
    ctx = await createTestContext({ settingsDefaults: { mfaPolicy: 'optional' } });
    await createUser(ctx, 'owner@example.com', 'owner');
    await createUser(ctx, 'admin@example.com', 'admin');
    ownerCookie = (await signIn(ctx, 'owner@example.com')).cookie;
    adminCookie = (await signIn(ctx, 'admin@example.com')).cookie;
  });

  afterAll(async () => {
    await ctx.close();
    await smtp.close();
    await other.close();
  });

  it('asks for host and sender before anything is sent', async () => {
    const response = await asOwner();
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'smtp_incomplete',
      details: { fields: ['host', 'from'] },
    });
  });

  it('sends with the stored settings to the requesting owner by default', async () => {
    const saved = await ctx.request({
      method: 'PATCH',
      url: '/api/settings',
      payload: { smtp: { ...STORED, host: '127.0.0.1', port: smtp.port } },
    });
    expect(saved.statusCode).toBe(200);
    const response = await asOwner();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      to: 'owner@example.com',
      unsaved: false,
      messageId: expect.any(String),
      response: expect.stringContaining('queued as FAKE123'),
    });
    expect(smtp.logins.at(-1)).toEqual({ user: 'mailer', pass: STORED_PASS });
    const mail = smtp.messages.at(-1);
    expect(mail?.to).toEqual(['owner@example.com']);
    expect(mail?.data).toContain('Subject: Conclavix: SMTP test');
    const entry = await ctx.database.collections.audit.findOne(
      { action: 'settings.smtp_tested' },
      { sort: { _id: -1 } },
    );
    expect(entry?.details).toEqual({ ok: true, to: '***@example.com', unsaved: false });
    expect(entry?.actor).toMatchObject({ type: 'user' });
  });

  it('tests unsaved values with the stored password without saving them', async () => {
    const before = await ctx.database.collections.settings.findOne({});
    const response = await asOwner({ to: 'ops@example.com', smtp: { port: other.port, pass: '' } });
    expect(response.json()).toMatchObject({
      ok: false,
      kind: 'sender',
      unsaved: true,
      to: 'ops@example.com',
      response: expect.stringContaining('553 5.7.1 Sender address rejected'),
    });
    expect(other.logins.at(-1)).toEqual({ user: 'mailer', pass: STORED_PASS });
    expect(await ctx.database.collections.settings.findOne({})).toEqual(before);
  });

  it('reports a rejected login without echoing the password', async () => {
    const response = await asOwner({ smtp: { pass: 'typed-wrong-password' } });
    const body = response.json();
    expect(body).toMatchObject({ ok: false, kind: 'auth', unsaved: true });
    expect(body.response).toContain('535 5.7.8 Authentication failed');
    expect(response.body).not.toContain('typed-wrong-password');
    expect(response.body).not.toContain(
      Buffer.from('\u0000mailer\u0000typed-wrong-password').toString('base64'),
    );
    expect(response.body).not.toContain(STORED_PASS);
  });

  it('reports a rejected recipient', async () => {
    const response = await asOwner({ to: 'nobody@example.com' });
    expect(response.json()).toMatchObject({
      ok: false,
      kind: 'recipient',
      response: expect.stringContaining('Recipient address rejected'),
    });
  });

  it('reports a server that cannot be reached', async () => {
    const response = await asOwner({ smtp: { port: await closedPort() } });
    expect(response.json()).toMatchObject({ ok: false, kind: 'connection' });
    const entry = await ctx.database.collections.audit.findOne(
      { action: 'settings.smtp_tested' },
      { sort: { _id: -1 } },
    );
    expect(entry?.details).toMatchObject({ ok: false, kind: 'connection', unsaved: true });
  });

  it('reports TLS spoken to a plain-text server as a TLS failure', async () => {
    const response = await asBoard({ to: 'ops@example.com', smtp: { secure: true } });
    expect(response.json()).toMatchObject({ ok: false, kind: 'tls' });
  });

  it('is owner-only and needs a recipient for the board token', async () => {
    const admin = await asBrowser(ctx, adminCookie, {
      method: 'POST',
      url: '/api/settings/smtp/test',
      payload: { smtp: { host: 'smtp.attacker.test' } },
    });
    expect(admin.statusCode).toBe(403);
    expect(admin.json()).toMatchObject({ error: 'owner_required' });
    const board = await asBoard();
    expect(board.statusCode).toBe(400);
    expect(board.json()).toMatchObject({ error: 'recipient_required' });
    expect((await asBoard({ to: 'not-an-address' })).statusCode).toBe(400);
    expect((await asBoard({ to: 'a@b.test', smtp: { password: 'x' } })).statusCode).toBe(400);
  });

  it('limits test mails per user and minute', async () => {
    // The owner has sent five test mails above; the board token one.
    const limited = await asOwner();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: 'rate_limited' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    for (let i = 0; i < 4; i += 1) {
      expect((await asBoard({ to: 'ops@example.com' })).statusCode).toBe(200);
    }
    expect((await asBoard({ to: 'ops@example.com' })).statusCode).toBe(429);
  });
});
