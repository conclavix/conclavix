import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SettingsService } from '../settings/service.js';
import { AUTH_BASE_PATH } from './better-auth.js';
import {
  MFA_ENROLMENT_AUTH_PATHS,
  MFA_ENROLMENT_ROUTES,
  ROUTE_PERMISSIONS,
  can,
  mfaRequiredFor,
  routeKey,
} from './permissions.js';
import type { Principal, PrincipalResolver } from './principal.js';

const PUBLIC_API_ROUTES = new Set(['/api/health']);
const AUTH_ROUTE = `${AUTH_BASE_PATH}/*`;
/** Turning 2FA off is refused while the MFA policy demands it for the caller's role. */
const TWO_FACTOR_DISABLE_PATH = '/two-factor/disable';

type Area = 'public' | 'auth' | 'board';

/**
 * The board API is everything under /api except the health check and the better-auth routes.
 * Both the matched route pattern and the raw path count, so neither unknown /api paths nor
 * oddly written paths that still match an /api route get past the check. /mcp has its own
 * run-token auth and is not touched here.
 */
function areaOf(request: FastifyRequest): Area {
  const route = request.routeOptions.url;
  if (route !== undefined && PUBLIC_API_ROUTES.has(route)) return 'public';
  if (route === AUTH_ROUTE) return 'auth';
  const path = request.url.split('?')[0] ?? '';
  return path.startsWith('/api') || (route?.startsWith('/api') ?? false) ? 'board' : 'public';
}

const deny = (reply: FastifyReply, status: number, error: string, message: string) =>
  reply.status(status).send({ error, message });

/** Fail at startup when a board route has no entry in the permission map. */
export function registerPermissionCheck(app: FastifyInstance): void {
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api/') || PUBLIC_API_ROUTES.has(route.url)) return;
    if (route.url === AUTH_ROUTE) return;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (!(routeKey(method, route.url) in ROUTE_PERMISSIONS)) {
        throw new Error(`no permission is mapped for ${method} ${route.url}`);
      }
    }
  });
}

/** Checks a long-lived request again, e.g. an open event stream. */
export type Reauthorizer = (request: FastifyRequest) => Promise<boolean>;

const samePrincipal = (a: Principal, b: Principal): boolean =>
  a.kind === 'user' ? b.kind === 'user' && a.userId === b.userId : b.kind === 'board';

/**
 * Authenticate every board request, enforce the MFA policy per request, then the role. Returns
 * a check that repeats all of this for a request that is still open (the event stream).
 */
export function registerAccessControl(
  app: FastifyInstance,
  resolver: PrincipalResolver,
  settings: SettingsService,
): Reauthorizer {
  app.decorateRequest('principal', null);

  const mfaMandatory = async (principal: Principal): Promise<boolean> => {
    if (principal.kind !== 'user') return false;
    const { mfaPolicy } = await settings.current();
    return mfaRequiredFor(mfaPolicy, principal.role);
  };

  const mfaPending = async (principal: Principal): Promise<boolean> =>
    principal.kind === 'user' && !principal.twoFactorEnabled && (await mfaMandatory(principal));

  /** better-auth routes: hold pending enrolments, and keep 2FA on where the policy wants it. */
  const checkAuthRoute = async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = await resolver.resolve(request, false);
    request.principal = principal;
    if (!principal) return;
    const path = (request.url.split('?')[0] ?? '').slice(AUTH_BASE_PATH.length);
    if (!MFA_ENROLMENT_AUTH_PATHS.has(path) && (await mfaPending(principal))) {
      return deny(reply, 403, 'mfa_enrollment_required', 'Set up two-factor authentication');
    }
    if (path === TWO_FACTOR_DISABLE_PATH && (await mfaMandatory(principal))) {
      return deny(
        reply,
        403,
        'mfa_required_by_policy',
        'The two-factor policy of this instance requires it for your role',
      );
    }
    return;
  };

  app.addHook('onRequest', async (request, reply) => {
    const area = areaOf(request);
    if (area === 'public') return;

    if (area === 'auth') return checkAuthRoute(request, reply);

    const principal = await resolver.resolve(request);
    if (!principal) {
      return deny(reply, 401, 'unauthorized', 'Missing or invalid credentials');
    }
    request.principal = principal;
    const route = request.routeOptions.url;
    if (route === undefined || !route.startsWith('/api')) return;
    const key = routeKey(request.method, route);
    if (!MFA_ENROLMENT_ROUTES.has(key) && (await mfaPending(principal))) {
      return deny(reply, 403, 'mfa_enrollment_required', 'Set up two-factor authentication');
    }
    const capability = ROUTE_PERMISSIONS[key];
    if (!capability || !can(principal.role, capability)) {
      return deny(reply, 403, 'forbidden', 'Your role does not allow this');
    }
  });

  return async (request) => {
    const route = request.routeOptions.url;
    const before = request.principal;
    if (route === undefined || !before) return false;
    const now = await resolver.resolve(request);
    if (!now || !samePrincipal(before, now)) return false;
    const key = routeKey(request.method, route);
    const capability = ROUTE_PERMISSIONS[key];
    if (!capability || !can(now.role, capability)) return false;
    return MFA_ENROLMENT_ROUTES.has(key) || !(await mfaPending(now));
  };
}
