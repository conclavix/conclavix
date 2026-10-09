import {
  mdiAccountGroupOutline,
  mdiBookArrowDownOutline,
  mdiCogOutline,
  mdiPowerPlugOutline,
  mdiShieldAccountOutline,
  mdiTextBoxSearchOutline,
} from '@mdi/js';
import type { RouteLocationRaw } from 'vue-router';

export interface UserMenuItem {
  key: string;
  title: string;
  icon: string;
  to: RouteLocationRaw;
  /** Roles that see the entry; omitted means everyone. */
  roles?: readonly string[];
}

export const ADMIN_ROLES = ['owner', 'admin'] as const;

/**
 * Administration entries of the user menu (users, roles, settings, skill directories, connections, audit). They are listed below
 * the personal entries, under an "Administration" header, and only for the roles they name.
 */
export const ADMIN_MENU_ITEMS: UserMenuItem[] = [
  {
    key: 'admin-users',
    title: 'Users',
    icon: mdiAccountGroupOutline,
    to: { name: 'admin-users' },
    roles: ADMIN_ROLES,
  },
  {
    key: 'admin-roles',
    title: 'Roles',
    icon: mdiShieldAccountOutline,
    to: { name: 'admin-roles' },
    roles: ADMIN_ROLES,
  },
  {
    key: 'admin-settings',
    title: 'Settings',
    icon: mdiCogOutline,
    to: { name: 'admin-settings' },
    roles: ADMIN_ROLES,
  },
  {
    key: 'admin-skill-directories',
    title: 'Skill directories',
    icon: mdiBookArrowDownOutline,
    to: { name: 'admin-skill-directories' },
    roles: ADMIN_ROLES,
  },
  {
    key: 'admin-connections',
    title: 'Connections',
    icon: mdiPowerPlugOutline,
    to: { name: 'admin-connections' },
    roles: ADMIN_ROLES,
  },
  {
    key: 'admin-audit',
    title: 'Audit log',
    icon: mdiTextBoxSearchOutline,
    to: { name: 'admin-audit' },
    roles: ADMIN_ROLES,
  },
];

export function visibleMenuItems(
  items: readonly UserMenuItem[],
  role: string | undefined,
): UserMenuItem[] {
  return items.filter((item) => !item.roles || (role !== undefined && item.roles.includes(role)));
}
