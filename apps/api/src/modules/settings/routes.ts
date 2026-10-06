import type { FastifyInstance } from 'fastify';
import { OWNER_ONLY_SETTINGS, updateSettingsSchema } from '@conclavix/core';
import type { Database } from '../../db.js';
import { AppError } from '../../errors.js';
import { parse } from '../../validation.js';
import type { AuditLog } from '../audit/audit.js';
import { actorOf, requirePrincipal } from '../auth/principal.js';
import { settingsView, type SettingsService } from './service.js';

/** Instance settings for admins; owner-only groups need the owner role to change. */
export function registerSettingsRoutes(
  app: FastifyInstance,
  database: Database,
  settings: SettingsService,
  audit: AuditLog,
  readOnly: Record<string, unknown>,
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

  app.get('/api/models', async () => ({ items: (await settings.current()).models }));
}
