import { api } from '../api/client';

export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];
export type MfaPolicy = 'optional' | 'required' | 'required_for_admins';

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  banned: boolean;
  twoFactorEnabled: boolean;
  createdAt: string;
  lastSignInAt?: string | null;
}

/** How a new or reset password reaches the user, as the users API reports it. */
export type PasswordDelivery =
  | { delivery: 'manual' }
  | { delivery: 'email' }
  | { delivery: 'temporary'; temporaryPassword: string; reason?: 'mail_failed' };

export interface RoleInfo {
  role: Role;
  description: string;
  capabilities: string[];
  users: number;
  activeUsers: number;
}

export interface RolesOverview {
  capabilities: { key: string; description: string }[];
  roles: RoleInfo[];
}

export const SETTING_GROUPS = ['instanceName', 'mfaPolicy', 'models', 'smtp'] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

export interface SmtpValues {
  host: string | null;
  port: number;
  secure: boolean;
  user: string | null;
  from: string | null;
  passSet: boolean;
}

export interface SettingsValues {
  instanceName: string;
  mfaPolicy: MfaPolicy;
  models: string[];
  smtp: SmtpValues;
}

export interface SettingsResponse {
  values: SettingsValues;
  sources: Record<SettingGroup, 'db' | 'env'>;
  readOnly: Record<string, unknown>;
  ownerOnly: SettingGroup[];
}

export interface SmtpPatch {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  from?: string;
  /** Write-only: omitted or empty keeps the stored password, null clears it. */
  pass?: string | null;
}

export interface SettingsPatch {
  instanceName?: string | null;
  mfaPolicy?: MfaPolicy | null;
  models?: string[] | null;
  smtp?: SmtpPatch | null;
}

export type SmtpFailureKind =
  'connection' | 'tls' | 'auth' | 'sender' | 'recipient' | 'message' | 'unknown';

/** The outcome of a test mail; `response` is the server's (sanitized) answer when there is one. */
export type SmtpTestResult =
  | { ok: true; to: string; unsaved: boolean; messageId: string; response: string | null }
  | {
      ok: false;
      to: string;
      unsaved: boolean;
      kind: SmtpFailureKind;
      message: string;
      response: string | null;
    };

export interface SmtpTestRequest {
  to?: string;
  smtp?: SmtpPatch;
}

export type AuditActor =
  | { type: 'user'; userId: string }
  | { type: 'board' }
  | { type: 'system' }
  | { type: 'agent'; agentId: string; name: string }
  | null;

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  actor: AuditActor;
  targetUserId: string | null;
  ip: string | null;
  details: Record<string, unknown>;
}

const send = <T>(path: string, method: string, body?: object) =>
  api<T>(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });

export const adminApi = {
  users: () => api<{ items: AdminUser[] }>('/users').then((page) => page.items),
  createUser: (input: { email: string; name: string; role: Role; password?: string }) =>
    send<{ user: AdminUser } & PasswordDelivery>('/users', 'POST', input),
  updateUser: (id: string, input: { name?: string; role?: Role }) =>
    send<AdminUser>(`/users/${id}`, 'PATCH', input),
  ban: (id: string) => send<AdminUser>(`/users/${id}/ban`, 'POST', {}),
  unban: (id: string) => send<AdminUser>(`/users/${id}/unban`, 'POST', {}),
  resetPassword: (id: string, password?: string) =>
    send<PasswordDelivery>(`/users/${id}/reset-password`, 'POST', password ? { password } : {}),
  resetMfa: (id: string) => send<AdminUser>(`/users/${id}/reset-2fa`, 'POST', {}),
  deleteUser: (id: string) => send<undefined>(`/users/${id}`, 'DELETE'),
  roles: () => api<RolesOverview>('/roles'),
  settings: () => api<SettingsResponse>('/settings'),
  updateSettings: (patch: SettingsPatch) => send<SettingsResponse>('/settings', 'PATCH', patch),
  testSmtp: (body: SmtpTestRequest) => send<SmtpTestResult>('/settings/smtp/test', 'POST', body),
  audit: (query: string) =>
    api<{ items: AuditEntry[]; nextCursor: string | null }>(`/audit?${query}`),
};
