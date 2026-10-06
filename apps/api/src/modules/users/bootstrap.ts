import { randomBytes } from 'node:crypto';
import { createUserSchema, type UserSummary } from '@conclavix/core';
import type { UserService } from './service.js';

/**
 * Create the first owner of an instance. Refuses while an active owner exists, so it cannot be
 * used to take over a running instance. Without a password one is generated and returned once.
 */
export async function createFirstOwner(
  users: UserService,
  input: { email: string; name: string; password?: string | undefined },
): Promise<{ user: UserSummary; generatedPassword: string | null }> {
  if ((await users.countOwners()) > 0) {
    throw new Error('an owner already exists; add further users through the board');
  }
  const generatedPassword = input.password ? null : randomBytes(18).toString('base64url');
  const parsed = createUserSchema.parse({
    email: input.email,
    name: input.name,
    role: 'owner',
    password: input.password ?? generatedPassword,
  });
  const { user } = await users.create(parsed, 'system');
  return { user, generatedPassword };
}
