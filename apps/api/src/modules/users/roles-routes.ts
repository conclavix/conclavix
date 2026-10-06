import type { FastifyInstance } from 'fastify';
import { ROLES } from '@conclavix/core';
import type { Collections } from '../../db.js';
import {
  CAPABILITY_DESCRIPTIONS,
  ROLE_CAPABILITIES,
  ROLE_DESCRIPTIONS,
  type Capability,
} from '../auth/permissions.js';
import { userRole } from '../auth/principal.js';

/** The fixed roles with their capabilities and how many users hold each, for the admin UI. */
export function registerRoleRoutes(app: FastifyInstance, collections: Collections): void {
  app.get('/api/roles', async () => {
    const docs = await collections.users.find({}, { projection: { role: 1, banned: 1 } }).toArray();
    const counts = Object.fromEntries(ROLES.map((role) => [role, { users: 0, active: 0 }]));
    for (const doc of docs) {
      const count = counts[userRole(doc)];
      if (!count) continue;
      count.users += 1;
      if (doc.banned !== true) count.active += 1;
    }
    const capabilities = Object.keys(CAPABILITY_DESCRIPTIONS) as Capability[];
    return {
      capabilities: capabilities.map((key) => ({
        key,
        description: CAPABILITY_DESCRIPTIONS[key],
      })),
      roles: ROLES.map((role) => ({
        role,
        description: ROLE_DESCRIPTIONS[role],
        capabilities: capabilities.filter((key) => ROLE_CAPABILITIES[role].has(key)),
        users: counts[role]?.users ?? 0,
        activeUsers: counts[role]?.active ?? 0,
      })),
    };
  });
}
