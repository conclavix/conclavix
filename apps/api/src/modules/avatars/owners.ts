import type { ClientSession } from 'mongodb';
import type { FastifyRequest } from 'fastify';
import type { AvatarOwnerType, Collections } from '../../db.js';
import { AppError, notFound } from '../../errors.js';
import { toObjectId } from '../../validation.js';
import { can } from '../auth/permissions.js';
import { requirePrincipal } from '../auth/principal.js';

/**
 * What the avatar module needs to know about one kind of owner.
 * assertExists raises 404 for unknown owners; assertCanWrite is where role checks plug in;
 * onChange mirrors the current ETag (or null) onto the owner inside the avatar transaction.
 */
export interface AvatarOwnerHandler {
  readonly label: string;
  assertExists(id: string, session?: ClientSession): Promise<void>;
  assertCanWrite(request: FastifyRequest, id: string): Promise<void>;
  onChange(id: string, etag: string | null, session: ClientSession): Promise<void>;
}

export type AvatarOwnerHandlers = Partial<Record<AvatarOwnerType, AvatarOwnerHandler>>;

const forbidden = (): AppError => new AppError(403, 'forbidden', 'Your role does not allow this');

/** Agent avatars are part of agent management: only roles that may change agents write them. */
export function agentAvatarOwner(collections: Collections): AvatarOwnerHandler {
  return {
    label: 'Agent',
    async assertExists(id, session) {
      const found = await collections.agents.countDocuments(
        { _id: toObjectId(id, 'Agent') },
        { limit: 1, ...(session ? { session } : {}) },
      );
      if (found === 0) {
        throw notFound('Agent');
      }
    },
    async assertCanWrite(request) {
      if (!can(requirePrincipal(request).role, 'agents')) throw forbidden();
    },
    async onChange(id, etag, session) {
      const result = await collections.agents.updateOne(
        { _id: toObjectId(id, 'Agent') },
        { $set: { avatarEtag: etag } },
        { session },
      );
      if (result.matchedCount === 0) {
        throw notFound('Agent');
      }
    },
  };
}

/**
 * User avatars belong to the user: they change their own, and roles that administer users may
 * change anyone's. The board token acts as an owner.
 */
export function userAvatarOwner(collections: Collections): AvatarOwnerHandler {
  return {
    label: 'User',
    async assertExists(id, session) {
      const found = await collections.users.countDocuments(
        { _id: toObjectId(id, 'User') },
        { limit: 1, ...(session ? { session } : {}) },
      );
      if (found === 0) {
        throw notFound('User');
      }
    },
    async assertCanWrite(request, id) {
      const principal = requirePrincipal(request);
      if (principal.kind === 'user' && principal.userId === id) return;
      if (!can(principal.role, 'users')) throw forbidden();
      if (principal.role === 'owner') return;
      // Same rule as every other change to a user: only an owner changes an owner.
      const target = await collections.users.findOne(
        { _id: toObjectId(id, 'User') },
        { projection: { role: 1 } },
      );
      if (target?.role === 'owner') {
        throw new AppError(403, 'owner_required', 'Only an owner can change an owner');
      }
    },
    async onChange(id, etag, session) {
      const result = await collections.users.updateOne(
        { _id: toObjectId(id, 'User') },
        { $set: { avatarEtag: etag } },
        { session },
      );
      if (result.matchedCount === 0) {
        throw notFound('User');
      }
    },
  };
}

/** Resolve the handler for an owner type, or explain that the type is not enabled yet. */
export function ownerHandler(
  handlers: AvatarOwnerHandlers,
  type: AvatarOwnerType,
): AvatarOwnerHandler {
  const handler = handlers[type];
  if (!handler) {
    throw new AppError(404, 'avatar_owner_disabled', `Avatars for ${type} owners are not enabled`);
  }
  return handler;
}
