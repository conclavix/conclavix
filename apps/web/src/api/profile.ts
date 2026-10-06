import { z } from 'zod';
import { api, apiValidated } from './client';

export type MfaPolicy = 'optional' | 'required' | 'required_for_admins';

/** Mirrors the server's PASSWORD_LIMITS; better-auth rejects anything outside them. */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export const apiTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
});
export type ApiToken = z.infer<typeof apiTokenSchema>;

const tokenListSchema = z.object({ items: z.array(apiTokenSchema) });
const createdTokenSchema = apiTokenSchema.extend({ token: z.string().min(1) });
export type CreatedApiToken = z.infer<typeof createdTokenSchema>;

export const sessionSchema = z.object({
  id: z.string(),
  token: z.string(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  expiresAt: z.string(),
  ipAddress: z.string().nullish(),
  userAgent: z.string().nullish(),
});
export type AuthSession = z.infer<typeof sessionSchema>;

const currentSessionSchema = z.object({ session: z.object({ id: z.string() }) }).nullable();
const enrolmentSchema = z.object({ totpURI: z.string(), backupCodes: z.array(z.string()) });
export type TwoFactorEnrolment = z.infer<typeof enrolmentSchema>;
const renamedSchema = z.object({ id: z.string(), name: z.string() });
const backupCodesSchema = z.object({ backupCodes: z.array(z.string()) });

const post = (body: object = {}): RequestInit => ({
  method: 'POST',
  body: JSON.stringify(body),
});

/** Same rule as the server: required means everyone, required_for_admins owners and admins. */
export function mfaRequiredFor(policy: MfaPolicy | undefined, role: string): boolean {
  if (policy === 'required') return true;
  if (policy === 'required_for_admins') return role === 'owner' || role === 'admin';
  return false;
}

/** Why 2FA cannot be turned off for this role under the policy, or null when it can. */
export function mfaDisableBlockedReason(
  policy: MfaPolicy | undefined,
  role: string,
): string | null {
  if (!mfaRequiredFor(policy, role)) return null;
  return policy === 'required'
    ? 'This instance requires two-factor authentication for every account.'
    : `This instance requires two-factor authentication for owners and admins, and your role is ${role}.`;
}

export interface PasswordStrength {
  /** 0 (unusable) to 4 (strong). */
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  color: 'error' | 'warning' | 'info' | 'success';
}

/**
 * A rough strength hint: length matters most, mixed character classes help, repeats and short
 * sequences hurt. It is advice only; the server enforces the length limits.
 */
export function passwordStrength(password: string): PasswordStrength {
  if (password.length < PASSWORD_MIN) return { score: 0, label: 'Too short', color: 'error' };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  const unique = new Set(password).size;
  let points = password.length >= 20 ? 2 : password.length >= 16 ? 1 : 0;
  points += classes >= 3 ? 2 : classes === 2 ? 1 : 0;
  if (unique < password.length / 3) points -= 2;
  if (/(.)\1{3,}/.test(password) || /(0123|1234|abcd|qwer|pass)/i.test(password)) points -= 1;
  const score = Math.max(1, Math.min(4, points)) as 1 | 2 | 3 | 4;
  const map = {
    1: { label: 'Weak', color: 'error' },
    2: { label: 'Fair', color: 'warning' },
    3: { label: 'Good', color: 'info' },
    4: { label: 'Strong', color: 'success' },
  } as const;
  return { score, ...map[score] };
}

const BROWSERS: [RegExp, string][] = [
  [/Edg\//, 'Edge'],
  [/OPR\//, 'Opera'],
  [/Firefox\//, 'Firefox'],
  [/Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
  [/curl\//, 'curl'],
];
const SYSTEMS: [RegExp, string][] = [
  [/Windows/, 'Windows'],
  [/Android/, 'Android'],
  [/iPhone|iPad/, 'iOS'],
  [/Mac OS X/, 'macOS'],
  [/Linux/, 'Linux'],
];

/** A short device description from a user agent, e.g. "Chrome on Linux". */
export function describeUserAgent(agent: string | null | undefined): string {
  if (!agent) return 'Unknown device';
  const browser = BROWSERS.find(([pattern]) => pattern.test(agent))?.[1] ?? 'Browser';
  const system = SYSTEMS.find(([pattern]) => pattern.test(agent))?.[1];
  return system ? `${browser} on ${system}` : browser;
}

/** The TOTP secret in an otpauth URI, for typing it into an authenticator app by hand. */
export function totpSecret(uri: string): string {
  try {
    return new URL(uri).searchParams.get('secret') ?? '';
  } catch {
    return '';
  }
}

export const profileApi = {
  rename: (name: string) =>
    apiValidated(renamedSchema, '/me', { method: 'PATCH', body: JSON.stringify({ name }) }),

  listTokens: async (): Promise<ApiToken[]> =>
    (await apiValidated(tokenListSchema, '/me/tokens')).items,
  createToken: (name: string, expiresInDays?: number) =>
    apiValidated(
      createdTokenSchema,
      '/me/tokens',
      post(expiresInDays ? { name, expiresInDays } : { name }),
    ),
  revokeToken: (id: string) => api<unknown>(`/me/tokens/${id}`, { method: 'DELETE' }),

  changePassword: (currentPassword: string, newPassword: string, revokeOtherSessions: boolean) =>
    api<unknown>(
      '/auth/change-password',
      post({ currentPassword, newPassword, revokeOtherSessions }),
    ),

  enableTwoFactor: (password: string) =>
    apiValidated(enrolmentSchema, '/auth/two-factor/enable', post({ password })),
  verifyTotp: (code: string) =>
    api<unknown>('/auth/two-factor/verify-totp', post({ code: code.trim() })),
  disableTwoFactor: (password: string) =>
    api<unknown>('/auth/two-factor/disable', post({ password })),
  generateBackupCodes: async (password: string): Promise<string[]> =>
    (
      await apiValidated(
        backupCodesSchema,
        '/auth/two-factor/generate-backup-codes',
        post({ password }),
      )
    ).backupCodes,

  listSessions: () => apiValidated(z.array(sessionSchema), '/auth/list-sessions'),
  currentSessionId: async (): Promise<string | null> =>
    (await apiValidated(currentSessionSchema, '/auth/get-session'))?.session.id ?? null,
  revokeSession: (token: string) => api<unknown>('/auth/revoke-session', post({ token })),
  revokeOtherSessions: () => api<unknown>('/auth/revoke-other-sessions', post()),
};
