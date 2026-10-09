import type { AuditActor, AuditEntry } from './api';

/** Actions the API writes today; the filter also accepts names typed by hand. */
export const KNOWN_ACTIONS = [
  'auth.sign_in',
  'auth.sign_in_failed',
  'auth.sign_in_mfa_pending',
  'auth.mfa_verified',
  'auth.mfa_failed',
  'auth.mfa_recovery_code_used',
  'auth.mfa_disabled',
  'auth.password_changed',
  'auth.password_reset',
  'auth.password_reset_requested',
  'project.archive_downloaded',
  'issue.workspace_created',
  'issue.workspace_removed',
  'issue.branch_synced',
  'user.created',
  'user.role_changed',
  'user.banned',
  'user.unbanned',
  'user.password_reset',
  'user.password_reset_mail_failed',
  'user.mfa_reset',
  'user.deleted',
  'settings.changed',
  'token.created',
  'token.revoked',
  'agent.project_default_changed',
  'agent.code_access_changed',
  'agent.git_integration_changed',
  'branch.merged',
  'branch.main_fast_forwarded',
  'project.agent_access_changed',
  'skill_source.created',
  'skill_source.updated',
  'skill_source.deleted',
  'skill.imported',
  'chat.plan_approved',
  'chat.project_created',
  'chat.issue_created',
] as const;

export interface AuditFilters {
  actions: string[];
  /** A user id, `board` or `system`. */
  actor: string | null;
  /** Local calendar days, `YYYY-MM-DD`; `to` includes the whole day. */
  from: string;
  to: string;
}

const startOfLocalDay = (day: string, offsetDays = 0): string | null => {
  const date = new Date(`${day}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString();
};

export function auditQuery(filters: AuditFilters, limit: number, before: string | null): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (filters.actions.length) params.set('action', filters.actions.join(','));
  if (filters.actor) params.set('actor', filters.actor);
  const from = filters.from ? startOfLocalDay(filters.from) : null;
  const to = filters.to ? startOfLocalDay(filters.to, 1) : null;
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (before) params.set('before', before);
  return params.toString();
}

/**
 * A user's display name. An id missing from a loaded user list belongs to a deleted user; without
 * the list (it failed to load) nothing is known beyond the id.
 */
export function userLabel(id: string, names: Record<string, string>, namesLoaded: boolean): string {
  return names[id] ?? `${namesLoaded ? 'deleted user' : 'user'} ${id.slice(-6)}`;
}

export function actorLabel(
  actor: AuditActor,
  names: Record<string, string>,
  namesLoaded = true,
): string {
  if (!actor) return 'anonymous';
  if (actor.type === 'board') return 'board token';
  if (actor.type === 'system') return 'system';
  if (actor.type === 'agent') return `agent ${actor.name}`;
  return userLabel(actor.userId, names, namesLoaded);
}

/** Detail keys that could carry a credential; dropped even though the API never writes them. */
const SECRET_KEY = /pass|secret|token|code|key|otp|totp/i;

const formatValue = (value: unknown): string =>
  Array.isArray(value) ? value.map(formatValue).join(', ') : String(value);

const isPlain = (value: unknown): boolean =>
  value !== null &&
  (typeof value !== 'object' ||
    (Array.isArray(value) && value.every((item) => item === null || typeof item !== 'object')));

/** A one-line description of an entry's details, never showing credential-like fields. */
export function auditSummary(entry: Pick<AuditEntry, 'action' | 'details'>): string {
  const details = Object.entries(entry.details ?? {}).filter(
    ([key, value]) => !SECRET_KEY.test(key) && isPlain(value),
  );
  const byKey = Object.fromEntries(details);
  if (entry.action === 'user.role_changed' && byKey['from'] && byKey['to']) {
    return `${formatValue(byKey['from'])} → ${formatValue(byKey['to'])}`;
  }
  return details.map(([key, value]) => `${key}: ${formatValue(value)}`).join(' · ');
}
