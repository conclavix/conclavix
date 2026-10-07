import type { ObjectId } from 'mongodb';
import type { MfaPolicy, Preferences, Role } from '@conclavix/core';

/** The better-auth user document, read and updated natively for roles and bans. */
export interface UserDoc {
  _id: ObjectId;
  email: string;
  name: string;
  emailVerified: boolean;
  role: Role;
  banned: boolean;
  twoFactorEnabled?: boolean;
  preferences?: Partial<Preferences>;
  avatarEtag?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionDoc {
  _id: ObjectId;
  userId: ObjectId;
  token: string;
  expiresAt: Date;
}

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

export interface AuditDoc {
  _id: ObjectId;
  at: Date;
  action: string;
  actor: { type: 'user'; userId: string } | { type: 'board' } | { type: 'system' } | null;
  targetUserId: string | null;
  ip: string | null;
  details: Record<string, unknown>;
}
