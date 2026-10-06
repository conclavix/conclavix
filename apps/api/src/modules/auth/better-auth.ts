import { AsyncLocalStorage } from 'node:async_hooks';
import { betterAuth } from 'better-auth';
import { mongodbAdapter } from 'better-auth/adapters/mongodb';
import { APIError } from 'better-auth/api';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { ObjectId } from 'mongodb';
import type { Database } from '../../db.js';
import type { Mailer } from './mailer.js';

/** Set by the Fastify bridge from request.ip; an incoming header of that name is dropped. */
export const CLIENT_IP_HEADER = 'x-conclavix-client-ip';
export const AUTH_BASE_PATH = '/api/auth';
export const RESET_PASSWORD_PAGE = '/reset-password';
export const PASSWORD_LIMITS = { min: 12, max: 128 } as const;

export interface AuthInstanceOptions {
  database: Database;
  secret: string;
  boardUrl: string;
  sessionTtlHours: number;
  transactions: boolean;
  rateLimit: boolean;
  issuer: string;
  mailer: Mailer;
}

const HOUR = 3600;
const resetDelivery = new AsyncLocalStorage<{ result?: Promise<boolean> }>();

/** Credential paths stay limited per client IP even with a session; reading the session is free. */
const customRules = {
  '/get-session': false,
  '/sign-in/email': { window: 60, max: 10 },
  '/request-password-reset': { window: 300, max: 5 },
  '/reset-password': { window: 300, max: 10 },
  '/change-password': { window: 60, max: 5 },
  '/two-factor/*': { window: 60, max: 10 },
} as const;

/** better-auth for the board: e-mail and password, TOTP with recovery codes, no self sign-up. */
export function createAuth(options: AuthInstanceOptions) {
  const { database, mailer } = options;
  const sessionTtl = options.sessionTtlHours * HOUR;
  return betterAuth({
    appName: options.issuer,
    secret: options.secret,
    baseURL: options.boardUrl,
    basePath: AUTH_BASE_PATH,
    trustedOrigins: [new URL(options.boardUrl).origin],
    telemetry: { enabled: false },
    database: mongodbAdapter(database.db, {
      client: database.client,
      transaction: options.transactions,
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: PASSWORD_LIMITS.min,
      maxPasswordLength: PASSWORD_LIMITS.max,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: HOUR,
      sendResetPassword: async ({ user, url }) => {
        const sending = mailer.send({
          to: user.email,
          subject: `Set your ${options.issuer} password`,
          text: [
            `Use this link to set a new password for ${user.email}:`,
            '',
            url,
            '',
            'The link expires in one hour. If you did not expect this mail, ignore it.',
          ].join('\n'),
        });
        const delivery = resetDelivery.getStore();
        if (delivery) delivery.result = sending;
        await sending;
      },
    },
    session: {
      expiresIn: sessionTtl,
      updateAge: Math.min(24 * HOUR, Math.floor(sessionTtl / 2)),
    },
    user: {
      additionalFields: {
        role: { type: 'string', input: false, required: false, defaultValue: 'viewer' },
        banned: { type: 'boolean', input: false, required: false, defaultValue: false },
      },
    },
    advanced: {
      useSecureCookies: new URL(options.boardUrl).protocol === 'https:',
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    rateLimit: { enabled: options.rateLimit, storage: 'memory', window: 60, max: 100, customRules },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const user = await database.collections.users.findOne({
              _id: new ObjectId(String(session.userId)),
            });
            if (!user || user.banned) {
              throw new APIError('FORBIDDEN', { message: 'This account is deactivated' });
            }
          },
        },
      },
    },
    plugins: [twoFactor({ issuer: options.issuer, backupCodeOptions: { amount: 10 } })],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** Better Auth masks mail failures on public routes; admin delivery needs the actual result. */
export async function requestPasswordResetEmail(
  auth: Auth,
  email: string,
  boardUrl: string,
): Promise<void> {
  const delivery: { result?: Promise<boolean> } = {};
  await resetDelivery.run(delivery, () =>
    auth.api.requestPasswordReset({
      body: { email, redirectTo: new URL(RESET_PASSWORD_PAGE, boardUrl).toString() },
    }),
  );
  if (!delivery.result || !(await delivery.result)) {
    throw new Error('Password reset email was not sent');
  }
}
