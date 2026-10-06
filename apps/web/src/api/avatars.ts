import { api, authHeaders, AuthError } from './client';

export type AvatarOwnerType = 'agent' | 'user';

export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const AVATAR_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

const ACCEPTED_TYPES = new Set(AVATAR_ACCEPT.split(','));
const MAX_CACHED = 200;
const objectUrls = new Map<string, Promise<string>>();

/** Explain why a picked file cannot be an avatar, or return null when it may be uploaded. */
export function avatarFileProblem(file: File): string | null {
  if (!ACCEPTED_TYPES.has(file.type)) {
    return 'Choose a PNG, JPEG, WebP, or GIF image.';
  }
  if (file.size > AVATAR_MAX_BYTES) {
    return 'The image is larger than 5 MB.';
  }
  return null;
}

async function download(url: string): Promise<string> {
  const response = await fetch(url, { credentials: 'same-origin', headers: authHeaders() });
  if (response.status === 401) {
    throw new AuthError();
  }
  if (!response.ok) {
    throw new Error(`avatar request failed with ${response.status}`);
  }
  return URL.createObjectURL(await response.blob());
}

/**
 * Load an avatar with the session cookie (or API token) and return an object URL for it.
 * URLs carry the ETag as ?v=, so one fetch per version is enough; failures are not cached.
 */
export function loadAvatar(url: string): Promise<string> {
  const cached = objectUrls.get(url);
  if (cached) {
    return cached;
  }
  const pending = download(url);
  pending.catch(() => objectUrls.delete(url));
  objectUrls.set(url, pending);
  if (objectUrls.size > MAX_CACHED) {
    const [oldest] = objectUrls.keys();
    if (oldest !== undefined) {
      const evicted = objectUrls.get(oldest);
      objectUrls.delete(oldest);
      void evicted?.then(URL.revokeObjectURL, () => undefined);
    }
  }
  return pending;
}

/** Upload a new avatar and return its versioned URL. */
export async function uploadAvatar(type: AvatarOwnerType, id: string, file: File): Promise<string> {
  const body = new FormData();
  body.append('file', file);
  const saved = await api<{ url: string }>(`/avatars/${type}/${id}`, { method: 'PUT', body });
  return saved.url;
}

/** Remove an avatar. */
export async function removeAvatar(type: AvatarOwnerType, id: string): Promise<void> {
  await api(`/avatars/${type}/${id}`, { method: 'DELETE' });
}

const PALETTE = ['primary', 'secondary', 'success', 'info', 'warning', 'error'] as const;

/** Up to two initials from a display name: first letters of two words, or two letters of one. */
export function initials(name: string): string {
  const words = name
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  const [first = '', second] = words;
  const text = second === undefined ? first.slice(0, 2) : `${first.charAt(0)}${second.charAt(0)}`;
  return text.toUpperCase() || '?';
}

/** A theme colour picked deterministically from a stable key such as an id or name. */
export function avatarColor(key: string): (typeof PALETTE)[number] {
  let hash = 0;
  for (const char of key) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length] ?? 'primary';
}
