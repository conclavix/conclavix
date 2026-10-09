import { z } from 'zod';

export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export const roleSchema = z.enum(ROLES);

export const mfaPolicySchema = z.enum(['optional', 'required', 'required_for_admins']);

export const THEME_MODES = ['light', 'dark', 'system'] as const;
export const themeModeSchema = z.enum(THEME_MODES);

/**
 * The vuetiwatch theme templates the board offers (vuetiwatch 0.2.4). The web app checks in a test
 * that this list matches the installed vuetiwatch, so an upgrade cannot drift silently.
 */
export const THEME_TEMPLATES = [
  'classic',
  'paper',
  'slate',
  'graphite',
  'atlas',
  'atlasDark',
  'atlasSepia',
  'calm',
  'lux',
  'soft',
  'candy',
  'clay',
  'morph',
  'sketchy',
  'brutalist',
  'liquidGlass',
  'darkGlass',
  'aurora',
  'neon',
] as const;
export const themeTemplateSchema = z.enum(THEME_TEMPLATES);

/** A user's theme layer: either field may be missing and then falls back to the next layer. */
export const themePreferenceSchema = z.strictObject({
  template: themeTemplateSchema.optional(),
  mode: themeModeSchema.optional(),
});

export const DEFAULT_THEME_PREFERENCE = { mode: 'system' } as const;

/** Stored before theme templates existed: a plain mode string, read as `{ mode }`. */
const legacyTheme = (value: unknown): unknown =>
  typeof value === 'string' ? { mode: value } : value;

/** The navigation drawer on wide screens: a rail that expands on hover, or pinned open. */
export const SIDEBAR_MODES = ['rail', 'pinned'] as const;
export const sidebarModeSchema = z.enum(SIDEBAR_MODES);

export const preferencesSchema = z.strictObject({
  theme: z.preprocess(legacyTheme, themePreferenceSchema).default(DEFAULT_THEME_PREFERENCE),
  /** Missing until the user picks one; the board then falls back to the device's choice. */
  sidebar: sidebarModeSchema.optional().catch(undefined),
});

const nameSchema = z.string().trim().min(1).max(100);
const emailSchema = z
  .email()
  .max(254)
  .transform((email) => email.toLowerCase());
export const passwordSchema = z.string().min(12).max(128);

export const createUserSchema = z.strictObject({
  email: emailSchema,
  name: nameSchema,
  role: roleSchema.default('member'),
  password: passwordSchema.optional(),
});

export const updateUserSchema = z
  .strictObject({ name: nameSchema, role: roleSchema })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');

export const resetPasswordSchema = z.strictObject({ password: passwordSchema.optional() });

export const updateMeSchema = z
  .strictObject({
    name: nameSchema,
    preferences: z
      .strictObject({ theme: themePreferenceSchema, sidebar: sidebarModeSchema })
      .partial(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');

export const createApiTokenSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  expiresInDays: z.int().min(1).max(3650).optional(),
});

export type Role = z.infer<typeof roleSchema>;
export type MfaPolicy = z.infer<typeof mfaPolicySchema>;
export type ThemeMode = z.infer<typeof themeModeSchema>;
export type ThemeTemplate = z.infer<typeof themeTemplateSchema>;
export type ThemePreference = z.infer<typeof themePreferenceSchema>;
export type SidebarMode = z.infer<typeof sidebarModeSchema>;
export type Preferences = z.infer<typeof preferencesSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type UpdateMeInput = z.infer<typeof updateMeSchema>;
export type CreateApiTokenInput = z.infer<typeof createApiTokenSchema>;

export interface UserSummary {
  id: string;
  email: string;
  name: string;
  role: Role;
  banned: boolean;
  twoFactorEnabled: boolean;
  avatarUrl: string | null;
  createdAt: Date;
  /** Latest successful sign-in from the audit log; only the user list fills it. */
  lastSignInAt?: Date | null;
}

export interface ApiTokenSummary {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
}
