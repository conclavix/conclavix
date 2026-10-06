import type { AvatarOwnerType } from '../../db.js';

/** Build the board URL of an owner's avatar, versioned by its ETag so caches never serve a stale image. */
export function avatarUrl(
  type: AvatarOwnerType,
  id: string,
  etag: string | null | undefined,
): string | null {
  return etag ? `/api/avatars/${type}/${id}?v=${etag}` : null;
}
