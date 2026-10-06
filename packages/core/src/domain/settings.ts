import { z } from 'zod';
import { mfaPolicySchema } from './user.js';

const modelSchema = z.string().trim().min(1).max(120);

const smtpPatchSchema = z
  .strictObject({
    host: z.string().trim().min(1).max(253),
    port: z.int().min(1).max(65535),
    secure: z.boolean(),
    user: z.string().max(254),
    /** Write-only: an empty string keeps the stored password, null clears it. */
    pass: z.string().max(1024).nullable(),
    from: z.string().trim().min(3).max(254),
  })
  .partial();

/** A null value removes the stored override so the ENV default applies again. */
export const updateSettingsSchema = z
  .strictObject({
    instanceName: z.string().trim().min(1).max(80).nullable(),
    mfaPolicy: mfaPolicySchema.nullable(),
    models: z.array(modelSchema).min(1).max(100).nullable(),
    smtp: smtpPatchSchema.nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');

export const SETTING_GROUPS = ['instanceName', 'mfaPolicy', 'models', 'smtp'] as const;
/**
 * Groups only owners may change. `smtp` decides where password-reset mail goes, so an admin who
 * could change it could intercept an owner's reset link and take over the account.
 */
export const OWNER_ONLY_SETTINGS = ['mfaPolicy', 'smtp'] as const;

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
export type SettingGroup = (typeof SETTING_GROUPS)[number];
