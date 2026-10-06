import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/client';
import type { AdminUser } from '../src/admin/api';
import {
  actionBlock,
  activeOwners,
  canEditGroup,
  errorText,
  grantableRoles,
  isAdminRole,
} from '../src/admin/gating';

const user = (id: string, role: AdminUser['role'], extra: Partial<AdminUser> = {}): AdminUser => ({
  id,
  email: `${id}@example.com`,
  name: id,
  role,
  banned: false,
  twoFactorEnabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});

describe('admin gating', () => {
  it('shows the administration area to owners and admins only', () => {
    expect(['owner', 'admin', 'member', 'viewer', undefined].map(isAdminRole)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it('lets only owners grant the owner role', () => {
    expect(grantableRoles('owner')).toEqual(['owner', 'admin', 'member', 'viewer']);
    expect(grantableRoles('admin')).toEqual(['admin', 'member', 'viewer']);
  });

  it('blocks every action on the own account', () => {
    const me = user('me', 'admin');
    for (const action of ['role', 'ban', 'resetPassword', 'resetMfa', 'delete'] as const) {
      expect(actionBlock({ id: 'me', role: 'admin' }, me, action, 2)).toMatch(/own account/);
    }
  });

  it('keeps admins away from owners', () => {
    const owner = user('o', 'owner');
    expect(actionBlock({ id: 'a', role: 'admin' }, owner, 'resetPassword', 2)).toMatch(
      /Only an owner/,
    );
    expect(actionBlock({ id: 'o2', role: 'owner' }, owner, 'resetPassword', 2)).toBeNull();
  });

  it('protects the last active owner from demotion, ban and deletion', () => {
    const owner = user('o', 'owner');
    const actor = { id: null, role: 'owner' };
    for (const action of ['role', 'ban', 'delete'] as const) {
      expect(actionBlock(actor, owner, action, 1)).toMatch(/last active owner/);
      expect(actionBlock(actor, owner, action, 2)).toBeNull();
    }
    expect(actionBlock(actor, owner, 'resetPassword', 1)).toBeNull();
    expect(actionBlock(actor, user('b', 'owner', { banned: true }), 'delete', 1)).toBeNull();
  });

  it('counts only active owners', () => {
    expect(
      activeOwners([user('a', 'owner'), user('b', 'owner', { banned: true }), user('c', 'admin')]),
    ).toBe(1);
  });

  it('offers a 2FA reset only when 2FA is set up', () => {
    const target = user('m', 'member', { twoFactorEnabled: false });
    expect(actionBlock({ id: 'a', role: 'admin' }, target, 'resetMfa', 1)).toMatch(/not set up/);
  });

  it('disables owner-only settings for admins', () => {
    const ownerOnly = ['mfaPolicy', 'smtp'] as const;
    expect(canEditGroup('admin', 'instanceName', ownerOnly)).toBe(true);
    expect(canEditGroup('admin', 'smtp', ownerOnly)).toBe(false);
    expect(canEditGroup('admin', 'mfaPolicy', ownerOnly)).toBe(false);
    expect(canEditGroup('owner', 'smtp', ownerOnly)).toBe(true);
    expect(canEditGroup('member', 'instanceName', ownerOnly)).toBe(false);
  });

  it('names the server rule in error messages', () => {
    expect(errorText(new ApiError('x', 409, 'last_owner'))).toMatch(/active owner must remain/);
    expect(errorText(new ApiError('x', 403, 'owner_required'))).toMatch(/Only an owner/);
    expect(errorText(new ApiError('nope', 403, 'other'))).toMatch(/permission/);
    expect(errorText(new ApiError('a user with this e-mail already exists', 409, 'conflict'))).toBe(
      'a user with this e-mail already exists',
    );
  });
});
