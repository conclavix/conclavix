import type { UserSummary } from '@conclavix/core';
import type { UserDoc } from '../../db.js';
import { userRole } from '../auth/principal.js';
import { avatarUrl } from '../avatars/url.js';

export function toUserSummary(doc: UserDoc): UserSummary {
  const id = doc._id.toHexString();
  return {
    id,
    email: doc.email,
    name: doc.name,
    role: userRole(doc),
    banned: doc.banned === true,
    twoFactorEnabled: doc.twoFactorEnabled === true,
    avatarUrl: avatarUrl('user', id, doc.avatarEtag),
    createdAt: doc.createdAt,
  };
}
