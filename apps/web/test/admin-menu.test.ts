import { describe, expect, it } from 'vitest';
import { isAdminRole } from '../src/admin/gating';
import { ADMIN_MENU_ITEMS, visibleMenuItems } from '../src/user-menu';

const ADMIN_ROUTES = [
  'admin-users',
  'admin-roles',
  'admin-settings',
  'admin-skill-directories',
  'admin-audit',
];

describe('administration menu entries', () => {
  it('link users, roles, settings, skill directories and audit in that order', () => {
    expect(ADMIN_MENU_ITEMS.map((item) => item.to)).toEqual(ADMIN_ROUTES.map((name) => ({ name })));
    expect(ADMIN_MENU_ITEMS.map((item) => item.title)).toEqual([
      'Users',
      'Roles',
      'Settings',
      'Skill directories',
      'Audit log',
    ]);
  });

  it('show only for the roles the router lets into the administration area', () => {
    for (const role of ['owner', 'admin', 'member', 'viewer', undefined]) {
      const keys = visibleMenuItems(ADMIN_MENU_ITEMS, role).map((item) => item.key);
      expect(keys).toEqual(isAdminRole(role) ? ADMIN_ROUTES : []);
    }
  });
});
