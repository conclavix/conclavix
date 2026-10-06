import type { Config } from '@conclavix/core';
import type { SettingsDefaults } from './service.js';

/** ENV values that apply until an admin stores an override in the settings document. */
export function settingsDefaults(config: Config): SettingsDefaults {
  return {
    instanceName: config.INSTANCE_NAME,
    mfaPolicy: config.MFA_POLICY,
    models: config.CONCLAVIX_MODELS,
    smtp: {
      host: config.SMTP_HOST ?? null,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      user: config.SMTP_USER ?? null,
      pass: config.SMTP_PASS ?? null,
      from: config.SMTP_FROM ?? null,
    },
  };
}
