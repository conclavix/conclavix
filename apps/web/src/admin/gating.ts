import { ApiError } from '../api/client';
import { ROLES, type AdminUser, type Role, type SettingGroup } from './api';

/** Owners and admins see the administration area; the server still checks every call. */
export const isAdminRole = (role: string | null | undefined): boolean =>
  role === 'owner' || role === 'admin';

/** Roles an actor may hand out: only owners grant the owner role. */
export const grantableRoles = (actorRole: string | null | undefined): Role[] =>
  actorRole === 'owner' ? [...ROLES] : ROLES.filter((role) => role !== 'owner');

export type UserAction = 'role' | 'ban' | 'unban' | 'resetPassword' | 'resetMfa' | 'delete';

export interface Actor {
  id: string | null;
  role: string;
}

/** Active (not banned) owners; the server never lets this drop to zero. */
export const activeOwners = (users: readonly AdminUser[]): number =>
  users.filter((user) => user.role === 'owner' && !user.banned).length;

/**
 * Why an action on a user is unavailable, mirroring the server's rules, or null when it may be
 * tried. The server stays authoritative; this only spares the admin a request bound to fail.
 */
export function actionBlock(
  actor: Actor,
  target: AdminUser,
  action: UserAction,
  owners: number,
): string | null {
  if (actor.id !== null && actor.id === target.id) {
    return 'You cannot do this to your own account; another admin has to.';
  }
  if (target.role === 'owner' && actor.role !== 'owner') {
    return 'Only an owner can change an owner.';
  }
  const removesOwner = action === 'role' || action === 'ban' || action === 'delete';
  if (target.role === 'owner' && !target.banned && removesOwner && owners <= 1) {
    return 'This is the last active owner; at least one must remain.';
  }
  if (action === 'resetMfa' && !target.twoFactorEnabled) {
    return 'Two-factor authentication is not set up for this user.';
  }
  return null;
}

/** Settings groups the actor may change: owner-only groups need the owner role. */
export const canEditGroup = (
  role: string | null | undefined,
  group: SettingGroup,
  ownerOnly: readonly SettingGroup[],
): boolean => isAdminRole(role) && (role === 'owner' || !ownerOnly.includes(group));

const ERROR_TEXT: Record<string, string> = {
  owner_required: 'Only an owner can do this.',
  last_owner: 'At least one active owner must remain. Make someone else an owner first.',
  forbidden: 'You do not have permission for this.',
};

/** A message for a failed admin call that names the rule the server enforced. */
export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const known = error.code ? ERROR_TEXT[error.code] : undefined;
    if (known) return known;
    if (error.status === 403) return ERROR_TEXT['forbidden'] as string;
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
