import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import {
  DEFAULT_THEME_PREFERENCE,
  THEME_MODES,
  preferencesSchema,
  updateMeSchema,
  type Preferences,
} from '@conclavix/core';
import type { Collections, UserDoc } from '../../db.js';
import { notFound } from '../../errors.js';
import { parse } from '../../validation.js';
import { mfaRequiredFor } from '../auth/permissions.js';
import { avatarUrl } from '../avatars/url.js';
import { requirePrincipal, requireUser, userRole } from '../auth/principal.js';
import type { SettingsService } from '../settings/service.js';

const preferencesOf = (doc: UserDoc): Preferences =>
  preferencesSchema.catch({ theme: DEFAULT_THEME_PREFERENCE }).parse(doc.preferences ?? {});

/**
 * Rewrite theme preferences stored as a plain mode string (before theme templates) to `{ mode }`.
 * Reads normalise them anyway; this keeps the stored documents in the current shape.
 */
export async function migrateThemePreferences(collections: Collections): Promise<number> {
  const result = await collections.users.updateMany(
    { 'preferences.theme': { $in: [...THEME_MODES] } },
    [{ $set: { 'preferences.theme': { mode: '$preferences.theme' } } }],
  );
  return result.modifiedCount;
}

/** Own profile and preferences. */
export function registerMeRoutes(
  app: FastifyInstance,
  collections: Collections,
  settings: SettingsService,
): void {
  const loadUser = async (userId: string): Promise<UserDoc> => {
    const doc = await collections.users.findOne({ _id: new ObjectId(userId) });
    if (!doc) throw notFound('User');
    return doc;
  };

  app.get('/api/me', async (request) => {
    const principal = requirePrincipal(request);
    const { mfaPolicy } = await settings.current();
    if (principal.kind === 'board') {
      return { kind: 'board', id: null, role: 'owner', mfaRequired: false, mfaPolicy };
    }
    const doc = await loadUser(principal.userId);
    const role = userRole(doc);
    const twoFactorEnabled = doc.twoFactorEnabled === true;
    return {
      kind: 'user',
      id: principal.userId,
      email: doc.email,
      name: doc.name,
      role,
      twoFactorEnabled,
      mfaPolicy,
      mfaRequired: !twoFactorEnabled && mfaRequiredFor(mfaPolicy, role),
      via: principal.via,
      preferences: preferencesOf(doc),
      avatarUrl: avatarUrl('user', principal.userId, doc.avatarEtag),
      createdAt: doc.createdAt,
    };
  });

  app.patch('/api/me', async (request) => {
    const user = requireUser(request);
    const input = parse(updateMeSchema, request.body);
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) set['name'] = input.name;
    for (const [key, value] of Object.entries(input.preferences ?? {})) {
      if (value !== undefined) set[`preferences.${key}`] = value;
    }
    await collections.users.updateOne({ _id: new ObjectId(user.userId) }, { $set: set });
    const doc = await loadUser(user.userId);
    return { id: user.userId, name: doc.name, preferences: preferencesOf(doc) };
  });
}
