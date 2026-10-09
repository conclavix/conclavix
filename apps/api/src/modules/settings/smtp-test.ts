import nodemailer from 'nodemailer';
import type { SmtpTestInput } from '@conclavix/core';
import { smtpTransportOptions } from '../auth/mailer.js';
import type { SmtpSettings } from './service.js';

/** Why a test mail failed, as far as the SMTP conversation tells. */
export type SmtpFailureKind =
  'connection' | 'tls' | 'auth' | 'sender' | 'recipient' | 'message' | 'unknown';

export type SmtpTestResult =
  | { ok: true; to: string; unsaved: boolean; messageId: string; response: string | null }
  | {
      ok: false;
      to: string;
      unsaved: boolean;
      kind: SmtpFailureKind;
      message: string;
      response: string | null;
    };

const FAILURE_MESSAGES: Record<SmtpFailureKind, string> = {
  connection: 'Could not connect to the SMTP server (check host, port and firewall).',
  tls: 'The TLS handshake failed (check the TLS switch, the port and the server certificate).',
  auth: 'The SMTP server rejected the login (check user and password).',
  sender: 'The SMTP server rejected the sender address.',
  recipient: 'The SMTP server rejected the recipient address.',
  message: 'The SMTP server rejected the message.',
  unknown: 'The test mail could not be sent.',
};

/** Fail fast: an owner waits for this answer, nodemailer's defaults allow minutes. */
const TEST_TIMEOUTS = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 };
const MAX_RESPONSE_CHARS = 300;

/** The stored settings with the unsaved form values on top; an empty password keeps the stored one. */
export function mergeSmtp(current: SmtpSettings, patch: SmtpTestInput['smtp']): SmtpSettings {
  if (!patch) return current;
  const { pass, ...rest } = patch;
  const merged: SmtpSettings = { ...current };
  for (const [key, value] of Object.entries(rest) as [keyof typeof rest, unknown][]) {
    if (value !== undefined) (merged as unknown as Record<string, unknown>)[key] = value;
  }
  if (pass === null) merged.pass = null;
  else if (pass) merged.pass = pass;
  return merged;
}

interface SmtpError {
  code?: unknown;
  command?: unknown;
  response?: unknown;
  message?: unknown;
}

const TLS_PATTERN = /certificate|ssl|tls|wrong version|handshake|self[- ]signed/i;
const FIXED_KINDS: Record<string, SmtpFailureKind> = {
  EAUTH: 'auth',
  ENOAUTH: 'auth',
  ETLS: 'tls',
  EMESSAGE: 'message',
};
/** Transport-level codes; TLS problems surface as one of these with a telling message. */
const NETWORK_CODES = new Set(['ECONNECTION', 'ETIMEDOUT', 'EDNS', 'ESOCKET', 'EPROTOCOL']);

/** Map a nodemailer error to a failure kind using its code, the failed command and the text. */
export function classifySmtpError(error: unknown): SmtpFailureKind {
  const { code, command, message } = (error ?? {}) as SmtpError;
  const text = typeof message === 'string' ? message : '';
  const name = typeof code === 'string' ? code : '';
  const fixed = FIXED_KINDS[name];
  if (fixed) return fixed;
  if (name === 'EENVELOPE') {
    const cmd = typeof command === 'string' ? command.toUpperCase() : '';
    if (cmd.startsWith('MAIL')) return 'sender';
    return cmd.startsWith('RCPT') || /recipient/i.test(text) ? 'recipient' : 'message';
  }
  if (TLS_PATTERN.test(text) || name.includes('CERT')) return 'tls';
  return NETWORK_CODES.has(name) ? 'connection' : 'unknown';
}

/**
 * Server text for the owner without the password in any form nodemailer might send it in
 * (plain, base64, AUTH PLAIN), without control characters and cut to a readable length.
 */
export function sanitizeSmtpText(text: unknown, smtp: SmtpSettings): string | null {
  if (typeof text !== 'string' || text.trim() === '') return null;
  let out = text;
  const pass = smtp.pass ?? '';
  if (pass) {
    const user = smtp.user ?? '';
    const secrets = [
      pass,
      Buffer.from(pass).toString('base64'),
      Buffer.from(`\u0000${user}\u0000${pass}`).toString('base64'),
      Buffer.from(`${user}\u0000${user}\u0000${pass}`).toString('base64'),
    ];
    for (const secret of secrets) out = out.split(secret).join('***');
  }
  out = out.replace(/\p{Cc}+/gu, ' ').trim();
  return out.length > MAX_RESPONSE_CHARS ? `${out.slice(0, MAX_RESPONSE_CHARS)}...` : out;
}

/** Send one test mail with the given settings and report the outcome instead of throwing. */
export async function sendTestMail(
  smtp: SmtpSettings,
  to: string,
  context: { unsaved: boolean; instanceName: string },
  extra: Parameters<typeof smtpTransportOptions>[1] = {},
): Promise<SmtpTestResult> {
  const transport = nodemailer.createTransport(
    smtpTransportOptions(smtp, { ...TEST_TIMEOUTS, ...extra }),
  );
  try {
    const info = await transport.sendMail({
      from: smtp.from ?? undefined,
      to,
      subject: `${context.instanceName}: SMTP test`,
      text: [
        `This is a test mail from ${context.instanceName}.`,
        '',
        'If you can read it, the SMTP settings work: password-reset and invitation mails',
        'are sent the same way.',
      ].join('\n'),
    });
    return {
      ok: true,
      to,
      unsaved: context.unsaved,
      messageId: info.messageId,
      response: sanitizeSmtpText(info.response, smtp),
    };
  } catch (error) {
    const kind = classifySmtpError(error);
    const { response, message } = (error ?? {}) as SmtpError;
    return {
      ok: false,
      to,
      unsaved: context.unsaved,
      kind,
      message: FAILURE_MESSAGES[kind],
      response: sanitizeSmtpText(typeof response === 'string' ? response : message, smtp),
    };
  } finally {
    transport.close();
  }
}

/** Counts attempts per key in fixed windows; enough for one process and an owner-only button. */
export class AttemptLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Count an attempt; returns null when allowed, else the seconds until the window resets. */
  take(key: string): number | null {
    const now = this.now();
    for (const [other, window] of this.windows) {
      if (now - window.start >= this.windowMs) this.windows.delete(other);
    }
    const window = this.windows.get(key) ?? { start: now, count: 0 };
    if (window.count >= this.max) {
      return Math.max(1, Math.ceil((window.start + this.windowMs - now) / 1000));
    }
    window.count += 1;
    this.windows.set(key, window);
    return null;
  }
}
