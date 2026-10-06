import type { FastifyBaseLogger } from 'fastify';
import type { ClientSession } from 'mongodb';
import {
  SETTING_GROUPS,
  type MfaPolicy,
  type SettingGroup,
  type UpdateSettingsInput,
} from '@conclavix/core';
import type { Collections, SettingsDoc, SmtpSettingsDoc } from '../../db.js';
import { AppError } from '../../errors.js';
import type { SecretBox } from './secret-box.js';

export const SETTINGS_ID = 'instance';
const CACHE_TTL_MS = 5000;

export interface SmtpSettings {
  host: string | null;
  port: number;
  secure: boolean;
  user: string | null;
  pass: string | null;
  from: string | null;
}

export interface SettingsDefaults {
  instanceName: string;
  mfaPolicy: MfaPolicy;
  models: string[];
  smtp: SmtpSettings;
}

export interface EffectiveSettings extends SettingsDefaults {
  sources: Record<SettingGroup, 'db' | 'env'>;
}

/**
 * Instance settings: a stored value overrides the ENV default, a removed one falls back to it.
 * Reads are cached briefly; when the database cannot be read the last known good values are
 * used, and without them the request fails rather than assuming a weaker MFA policy.
 */
export class SettingsService {
  private cached: { value: EffectiveSettings; at: number } | null = null;

  constructor(
    private readonly collections: Collections,
    private readonly defaults: SettingsDefaults,
    private readonly box: SecretBox,
    private readonly log: FastifyBaseLogger,
    private readonly ttlMs = CACHE_TTL_MS,
  ) {}

  async current(): Promise<EffectiveSettings> {
    if (this.cached && Date.now() - this.cached.at < this.ttlMs) {
      return this.cached.value;
    }
    try {
      const doc = await this.collections.settings.findOne({ _id: SETTINGS_ID });
      const value = this.resolve(doc);
      this.cached = { value, at: Date.now() };
      return value;
    } catch (error) {
      if (this.cached) {
        this.log.warn({ err: error }, 'settings read failed, using last known good values');
        return this.cached.value;
      }
      this.log.error({ err: error }, 'settings read failed and nothing is cached');
      throw new AppError(503, 'settings_unavailable', 'Instance settings are unavailable');
    }
  }

  /**
   * Apply a patch within the caller's transaction and return the groups that were touched. The
   * cache is dropped here and again by `invalidate` once the transaction has finished.
   */
  async update(input: UpdateSettingsInput, session: ClientSession): Promise<SettingGroup[]> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    const unset: Record<string, ''> = {};
    const changed: SettingGroup[] = [];
    const scalar = (group: 'instanceName' | 'mfaPolicy' | 'models'): void => {
      const value = input[group];
      if (value === undefined) return;
      changed.push(group);
      if (value === null) unset[group] = '';
      else set[group] = value;
    };
    scalar('instanceName');
    scalar('mfaPolicy');
    scalar('models');
    if (input.smtp !== undefined) {
      changed.push('smtp');
      if (input.smtp === null) {
        unset['smtp'] = '';
      } else {
        const { pass, ...rest } = input.smtp;
        for (const [key, value] of Object.entries(rest)) {
          if (value !== undefined) set[`smtp.${key}`] = value;
        }
        // An empty marker records "no password" so the ENV default does not come back.
        if (pass === null) set['smtp.passEncrypted'] = '';
        else if (pass) set['smtp.passEncrypted'] = this.box.seal(pass);
      }
    }
    await this.collections.settings.updateOne(
      { _id: SETTINGS_ID },
      { $set: set, ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}) },
      { upsert: true, session },
    );
    this.cached = null;
    return changed;
  }

  /** Forget cached values, e.g. after a settings transaction committed or aborted. */
  invalidate(): void {
    this.cached = null;
  }

  private resolve(doc: SettingsDoc | null): EffectiveSettings {
    const d = this.defaults;
    return {
      instanceName: doc?.instanceName ?? d.instanceName,
      mfaPolicy: doc?.mfaPolicy ?? d.mfaPolicy,
      models: doc?.models ?? d.models,
      smtp: doc?.smtp ? this.mergeSmtp(doc.smtp) : d.smtp,
      sources: Object.fromEntries(
        SETTING_GROUPS.map((group) => [group, doc?.[group] !== undefined ? 'db' : 'env']),
      ) as EffectiveSettings['sources'],
    };
  }

  private mergeSmtp(stored: SmtpSettingsDoc): SmtpSettings {
    const d = this.defaults.smtp;
    let pass = d.pass;
    if (stored.passEncrypted === '') {
      pass = null;
    } else if (stored.passEncrypted) {
      try {
        pass = this.box.open(stored.passEncrypted);
      } catch (error) {
        this.log.error(
          { err: error },
          'stored SMTP password could not be decrypted; using ENV default',
        );
      }
    }
    return {
      host: stored.host ?? d.host,
      port: stored.port ?? d.port,
      secure: stored.secure ?? d.secure,
      user: stored.user ?? d.user,
      pass,
      from: stored.from ?? d.from,
    };
  }
}

/** What the settings API shows: never the SMTP password, only whether one is set. */
export function settingsView(settings: EffectiveSettings, readOnly: Record<string, unknown>) {
  const { pass, ...smtp } = settings.smtp;
  return {
    values: {
      instanceName: settings.instanceName,
      mfaPolicy: settings.mfaPolicy,
      models: settings.models,
      smtp: { ...smtp, passSet: pass !== null && pass !== '' },
    },
    sources: settings.sources,
    readOnly,
  };
}
