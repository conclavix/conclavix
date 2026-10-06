import type { FastifyBaseLogger } from 'fastify';
import { supportsTransactions, type Database } from '../../db.js';
import { AuditLog } from '../audit/audit.js';
import { SecretBox } from '../settings/secret-box.js';
import { SettingsService, type SettingsDefaults } from '../settings/service.js';
import { ApiTokenRepository } from '../tokens/repository.js';
import { UserService } from '../users/service.js';
import { createAuth, type Auth } from './better-auth.js';
import { SettingsMailer } from './mailer.js';

export interface AuthSystemOptions {
  database: Database;
  secret: string;
  boardUrl: string;
  sessionTtlHours: number;
  rateLimit: boolean;
  defaults: SettingsDefaults;
  log: FastifyBaseLogger;
}

export interface AuthSystem {
  auth: Auth;
  settings: SettingsService;
  audit: AuditLog;
  tokens: ApiTokenRepository;
  users: UserService;
}

/** Wire better-auth, settings, mail, audit, tokens and users; shared by the API and the CLI. */
export async function createAuthSystem(options: AuthSystemOptions): Promise<AuthSystem> {
  const { database, log } = options;
  const transactions = await supportsTransactions(database.db);
  if (!transactions) {
    log.warn('MongoDB is not a replica set; better-auth runs without transactions');
  }
  const settings = new SettingsService(
    database.collections,
    options.defaults,
    new SecretBox(options.secret),
    log,
  );
  const auth = createAuth({
    database,
    secret: options.secret,
    boardUrl: options.boardUrl,
    sessionTtlHours: options.sessionTtlHours,
    transactions,
    rateLimit: options.rateLimit,
    // INSTANCE_NAME is captured at startup; later settings changes do not change TOTP URIs.
    issuer: options.defaults.instanceName,
    mailer: new SettingsMailer(settings, log),
  });
  const audit = new AuditLog(database.collections, log);
  const tokens = new ApiTokenRepository(database.collections);
  const users = new UserService(database, auth, settings, tokens, audit, options.boardUrl);
  return { auth, settings, audit, tokens, users };
}
