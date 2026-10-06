import { ApiError } from '../api/client';
import type {
  DirectoryDetail,
  DirectoryQuota,
  SkillSource,
  SkillSourceInput,
} from '../api/skill-sources';

export const PROVIDER_LABELS: Record<string, string> = {
  skillsdirectory: 'Skills Directory',
};

export const providerLabel = (provider: string): string => PROVIDER_LABELS[provider] ?? provider;

/** A valid library name from a directory slug (mirrors skillNameFromSlug in @conclavix/core). */
export function suggestSkillName(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}

/** "87 of 100 requests left today (free plan)", or null while the directory has not said. */
export function quotaText(quota: DirectoryQuota | null | undefined): string | null {
  if (!quota || quota.remaining === null) return null;
  const count =
    quota.limit !== null ? `${quota.remaining} of ${quota.limit}` : String(quota.remaining);
  const noun = quota.remaining === 1 && quota.limit === null ? 'request' : 'requests';
  const plan = quota.tier ? ` (${quota.tier} plan)` : '';
  return `${count} ${noun} left today${plan}`;
}

export interface ImportState {
  allowed: boolean;
  /** Why importing is not possible, shown next to the disabled button. */
  reason: string | null;
  /** Where the skill can be read instead. */
  url: string | null;
}

/** Whether a directory entry can be imported, and why not. */
export function importState(detail: DirectoryDetail | null): ImportState {
  if (!detail) return { allowed: false, reason: null, url: null };
  if (!detail.content.available) {
    return { allowed: false, reason: detail.content.message, url: detail.skill.webUrl };
  }
  return { allowed: true, reason: null, url: detail.skill.webUrl };
}

/** Avatars come from the directory; only https URLs are shown. */
export const safeImageUrl = (value: string | null): string | null => {
  if (!value) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
};

const ERRORS: Record<string, string> = {
  directory_auth_failed: 'The directory rejected the API key. Check it under Administration.',
  directory_rate_limited: 'The daily request limit of this directory is used up.',
  directory_unavailable: 'The directory could not be reached. Try again later.',
  directory_timeout: 'The directory did not answer in time. Try again later.',
  directory_invalid_response: 'The directory sent an answer Conclavix does not understand.',
  directory_disabled: 'This directory is disabled.',
  directory_address_blocked: 'The directory URL points to a private or local network address.',
  forbidden: 'You do not have permission for this.',
};

/** A user-facing message for a failed directory call. */
export function directoryErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    const known = error.code ? ERRORS[error.code] : undefined;
    if (error.code === 'directory_rate_limited') {
      const resetAt = (error.details as { resetAt?: string | null } | undefined)?.resetAt;
      const when = resetAt ? new Date(resetAt) : null;
      return when && !Number.isNaN(when.getTime())
        ? `${known} It resets ${when.toLocaleString()}.`
        : (known as string);
    }
    if (known) return known;
    if (error.status === 403) return ERRORS['forbidden'] as string;
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export interface SourceDraft {
  name: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  removeKey: boolean;
  enabled: boolean;
}

/**
 * The request body for a source form: the key only when typed (or null to remove it), and on an
 * edit an empty URL as null so the provider default applies again.
 */
export function sourcePayload(value: SourceDraft, existing: SkillSource | null): SkillSourceInput {
  const baseUrl = value.baseUrl.trim();
  const body: SkillSourceInput = { name: value.name.trim(), enabled: value.enabled };
  if (!existing) {
    body.provider = value.provider;
    if (baseUrl) body.baseUrl = baseUrl;
    if (value.apiKey) body.apiKey = value.apiKey;
    return body;
  }
  body.baseUrl = baseUrl || null;
  if (value.removeKey) body.apiKey = null;
  else if (value.apiKey) body.apiKey = value.apiKey;
  return body;
}
