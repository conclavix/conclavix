import type { FastifyInstance } from 'fastify';
import { OWNER_ONLY_SETTINGS, smtpTestSchema, updateSettingsSchema } from '@conclavix/core';
import type { Database } from '../../db.js';
import { AppError } from '../../errors.js';
import { parse } from '../../validation.js';
import type { AuditLog } from '../audit/audit.js';
import { actorOf, requirePrincipal } from '../auth/principal.js';
import { settingsView, type SettingsService } from './service.js';
import { AttemptLimiter, mergeSmtp, sendTestMail } from './smtp-test.js';

/** Test mails per principal and minute: enough to fix a typo, too few to spam or scan ports. */
const SMTP_TESTS_PER_MINUTE = 5;

const maskAddress = (address: string): string => address.replace(/^[^@]*/, '***');

/** Instance settings for admins; owner-only groups need the owner role to change. */
export function registerSettingsRoutes(
  app: FastifyInstance,
  database: Database,
  settings: SettingsService,
  audit: AuditLog,
  readOnly: Record<string, unknown>,
  smtpTestLimiter = new AttemptLimiter(SMTP_TESTS_PER_MINUTE, 60_000),
): void {
  const view = async () => ({
    ...settingsView(await settings.current(), readOnly),
    ownerOnly: OWNER_ONLY_SETTINGS,
  });

  app.get('/api/settings', view);

  app.patch('/api/settings', async (request) => {
    const principal = requirePrincipal(request);
    const input = parse(updateSettingsSchema, request.body);
    const ownerOnly = OWNER_ONLY_SETTINGS.filter((group) => input[group] !== undefined);
    if (ownerOnly.length > 0 && principal.role !== 'owner') {
      throw new AppError(403, 'owner_required', 'Only an owner can change these settings', {
        fields: ownerOnly,
      });
    }
    try {
      // The change and its audit entry commit together; a failed audit write fails the change.
      await database.inTransaction(async (session) => {
        const changed = await settings.update(input, session);
        await audit.write(
          {
            action: 'settings.changed',
            actor: actorOf(principal),
            ip: request.ip,
            details: { groups: changed },
          },
          session,
        );
      });
    } finally {
      settings.invalidate();
    }
    return view();
  });

  registerSmtpTestRoute(app, settings, audit, smtpTestLimiter);

  app.get('/api/models', async () => ({ items: (await settings.current()).models }));
}

/**
 * Owner-only like changing SMTP: the test may use unsaved values together with the stored
 * password, so it must not let an admin send that password to a host of their choice.
 */
function registerSmtpTestRoute(
  app: FastifyInstance,
  settings: SettingsService,
  audit: AuditLog,
  limiter: AttemptLimiter,
): void {
  app.post('/api/settings/smtp/test', async (request, reply) => {
    const principal = requirePrincipal(request);
    if (principal.role !== 'owner') {
      throw new AppError(403, 'owner_required', 'Only an owner can send an SMTP test mail', {
        fields: ['smtp'],
      });
    }
    const input = parse(smtpTestSchema, request.body ?? {});
    const to = input.to ?? (principal.kind === 'user' ? principal.email : undefined);
    if (!to) {
      throw new AppError(400, 'recipient_required', 'Name a recipient for the test mail');
    }
    const current = await settings.current();
    const smtp = mergeSmtp(current.smtp, input.smtp);
    if (!smtp.host || !smtp.from) {
      throw new AppError(400, 'smtp_incomplete', 'Set the SMTP host and sender first', {
        fields: [...(smtp.host ? [] : ['host']), ...(smtp.from ? [] : ['from'])],
      });
    }
    const wait = limiter.take(principal.kind === 'user' ? principal.userId : 'board');
    if (wait !== null) {
      void reply.header('retry-after', String(wait));
      throw new AppError(429, 'rate_limited', 'Too many test mails; try again shortly', {
        retryAfterSeconds: wait,
      });
    }
    const unsaved = input.smtp !== undefined && Object.keys(input.smtp).length > 0;
    const result = await sendTestMail(smtp, to, { unsaved, instanceName: current.instanceName });
    await audit.record({
      action: 'settings.smtp_tested',
      actor: actorOf(principal),
      ip: request.ip,
      details: {
        ok: result.ok,
        ...(result.ok ? {} : { kind: result.kind }),
        to: maskAddress(to),
        unsaved,
      },
    });
    return result;
  });
}
