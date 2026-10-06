import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuditLog } from '../audit/audit.js';
import type { StreamConnections } from '../stream/connections.js';
import { AUTH_BASE_PATH, CLIENT_IP_HEADER, type Auth } from './better-auth.js';
import { actorOf } from './principal.js';

/** The better-auth endpoints the board uses; everything else under /api/auth answers 404. */
const ALLOWED: ReadonlySet<string> = new Set([
  'POST /sign-in/email',
  'POST /sign-out',
  'GET /get-session',
  'POST /request-password-reset',
  'POST /reset-password',
  'POST /change-password',
  'GET /list-sessions',
  'POST /revoke-session',
  'POST /revoke-sessions',
  'POST /revoke-other-sessions',
  'POST /two-factor/enable',
  'POST /two-factor/disable',
  'POST /two-factor/get-totp-uri',
  'POST /two-factor/verify-totp',
  'POST /two-factor/verify-backup-code',
  'POST /two-factor/generate-backup-codes',
]);
const RESET_LINK = /^\/reset-password\/[^/]+$/;

/** Endpoints that can end the caller's sessions or change what they may do. */
const ACCESS_CHANGING: ReadonlySet<string> = new Set([
  '/sign-out',
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
  '/change-password',
  '/two-factor/disable',
]);

function isAllowed(method: string, path: string): boolean {
  return ALLOWED.has(`${method} ${path}`) || (method === 'GET' && RESET_LINK.test(path));
}

const AUDITED: Readonly<Record<string, [success: string, failure: string]>> = {
  '/sign-in/email': ['auth.sign_in', 'auth.sign_in_failed'],
  '/two-factor/verify-totp': ['auth.mfa_verified', 'auth.mfa_failed'],
  '/two-factor/verify-backup-code': ['auth.mfa_recovery_code_used', 'auth.mfa_failed'],
  '/two-factor/disable': ['auth.mfa_disabled', 'auth.mfa_disable_failed'],
  '/change-password': ['auth.password_changed', 'auth.password_change_failed'],
  '/reset-password': ['auth.password_reset', 'auth.password_reset_failed'],
  '/request-password-reset': ['auth.password_reset_requested', 'auth.password_reset_failed'],
};

function toWebRequest(request: FastifyRequest, baseUrl: string): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || name === CLIENT_IP_HEADER) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, String(item));
  }
  headers.set(CLIENT_IP_HEADER, request.ip);
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  if (hasBody) {
    headers.set('content-type', 'application/json');
    headers.delete('content-length');
  }
  return new Request(new URL(request.url, baseUrl), {
    method: request.method,
    headers,
    ...(hasBody ? { body: JSON.stringify(request.body ?? {}) } : {}),
  });
}

const emailBody = z.object({ email: z.string().trim().toLowerCase().max(254).email() });
const userResponse = z.object({ user: z.object({ id: z.string() }) });

function emailOf(body: unknown): string | null {
  const parsed = emailBody.safeParse(body);
  return parsed.success ? parsed.data.email : null;
}

function userIdOf(text: string): string | null {
  try {
    const parsed = userResponse.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.user.id : null;
  } catch {
    // Some auth routes return non-JSON responses; no user id is expected in those cases.
    return null;
  }
}

/** Record sign-in, 2FA and password events after better-auth has handled them. */
async function auditAuthEvent(
  audit: AuditLog,
  request: FastifyRequest,
  path: string,
  status: number,
  text: string,
): Promise<void> {
  const audited = AUDITED[path];
  if (!audited || request.method !== 'POST' || status === 429) return;
  const ok = status < 400;
  const pendingMfa = ok && text.includes('"twoFactorRedirect":true');
  const email = emailOf(request.body);
  const userId = userIdOf(text);
  await audit.record({
    action: pendingMfa ? 'auth.sign_in_mfa_pending' : audited[ok ? 0 : 1],
    actor: userId ? { type: 'user', userId } : actorOf(request.principal),
    targetUserId: userId,
    ip: request.ip,
    details: email ? { email } : {},
  });
}

/** Mount better-auth under /api/auth and audit sign-ins, 2FA and password events. */
export function registerAuthRoutes(
  app: FastifyInstance,
  auth: Auth,
  baseUrl: string,
  audit: AuditLog,
  streams: StreamConnections,
): void {
  app.route({
    method: ['GET', 'POST'],
    url: `${AUTH_BASE_PATH}/*`,
    handler: async (request, reply) => {
      const path = (request.url.split('?')[0] ?? '').slice(AUTH_BASE_PATH.length);
      if (!isAllowed(request.method, path)) {
        return reply.status(404).send({ error: 'not_found', message: 'Route not found' });
      }
      const response = await auth.handler(toWebRequest(request, baseUrl));
      const text = await response.text();

      await auditAuthEvent(audit, request, path, response.status, text);
      const caller = request.principal;
      if (ACCESS_CHANGING.has(path) && response.status < 400 && caller?.kind === 'user') {
        // Event streams opened with an ended session must close now, not at their next check.
        await streams.recheckUser(caller.userId);
      }

      reply.status(response.status);
      response.headers.forEach((value, name) => {
        if (name !== 'set-cookie' && name !== 'content-length' && name !== 'content-encoding') {
          reply.header(name, value);
        }
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) reply.header('set-cookie', cookies);
      return reply.send(text === '' ? undefined : text);
    },
  });
}
