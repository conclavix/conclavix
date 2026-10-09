import type { ObjectId } from 'mongodb';
import type { MfaPolicy } from '@conclavix/core';

/** A personal API token; only its hash is stored. */
export interface ApiTokenDoc {
  _id: ObjectId;
  userId: ObjectId;
  name: string;
  prefix: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
}

export interface SmtpSettingsDoc {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  passEncrypted?: string;
  from?: string;
}

export interface SettingsDoc {
  _id: string;
  instanceName?: string;
  mfaPolicy?: MfaPolicy;
  models?: string[];
  smtp?: SmtpSettingsDoc;
  updatedAt: Date;
}
