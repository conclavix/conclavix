import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AUTH_BASE_PATH } from './better-auth.js';

const UNSAFE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOGGED_ORIGIN_MAX = 80;

export const CSRF_ERROR = 'csrf_origin_mismatch';

const AUTH_ROUTE = `${AUTH_BASE_PATH}/*`;

const underApi = (path: string): boolean => path === '/api' || path.startsWith('/api/');

const firstHeader = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

function originOf(value: string): string | null {
  try {
    const { origin } = new URL(value);
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/** Short, printable form of an untrusted header value for the log line. */
function sanitized(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const printable = value.replace(/[^\x20-\x7e]/g, '?');
  return printable.length > LOGGED_ORIGIN_MAX
    ? `${printable.slice(0, LOGGED_ORIGIN_MAX)}...`
    : printable;
}

/**
 * Whether the request carries ambient browser credentials that a page could make a browser send.
 * A bearer header is never ambient, and on board routes it is authoritative over the cookie (see
 * PrincipalResolver.resolve). Under /api/auth better-auth reads only the cookie, so a bearer header
 * exempts nothing there; a sign-in without a cookie is checked whenever it comes from a browser
 * context, which blocks a login CSRF from a sibling subdomain.
 */
function needsOriginCheck(request: FastifyRequest): boolean {
  if (!UNSAFE_METHODS.has(request.method)) return false;
  const path = request.url.split('?')[0] ?? '';
  const route = request.routeOptions.url ?? '';
  if (!underApi(path) && !underApi(route)) return false;
  const { headers } = request;
  if (route === AUTH_ROUTE || path.startsWith(`${AUTH_BASE_PATH}/`)) {
    return (
      headers.cookie !== undefined ||
      headers.origin !== undefined ||
      headers.referer !== undefined ||
      headers['sec-fetch-site'] !== undefined
    );
  }
  if ((headers.authorization ?? '').startsWith('Bearer ')) return false;
  return headers.cookie !== undefined;
}

/**
 * Reject state-changing /api requests made with the session cookie unless they come from the
 * board's own origin. SameSite=Lax does not stop requests from sibling subdomains, which are
 * same-site, so the Origin (or Referer) must equal the origin of BOARD_URL exactly, and Fetch
 * Metadata, when sent, must say same-origin. /mcp, safe methods and bearer clients are untouched.
 */
export function registerOriginCheck(app: FastifyInstance, boardUrl: string): void {
  const boardOrigin = new URL(boardUrl).origin;

  app.addHook('onRequest', async (request, reply) => {
    if (!needsOriginCheck(request)) return;

    const site = firstHeader(request.headers['sec-fetch-site']);
    const originHeader = firstHeader(request.headers.origin);
    const refererHeader = firstHeader(request.headers.referer);
    const claimed = originHeader ?? refererHeader;
    const origin = claimed === undefined ? null : originOf(claimed);

    let reason: string | null = null;
    if (site !== undefined && site !== 'same-origin') reason = 'fetch_site';
    else if (claimed === undefined) reason = 'missing_origin';
    else if (origin !== boardOrigin) reason = 'origin_mismatch';
    if (reason === null) return;

    request.log.warn(
      {
        csrf: {
          reason,
          method: request.method,
          route: request.routeOptions.url ?? null,
          origin: sanitized(originHeader ?? (refererHeader ? (origin ?? 'invalid') : undefined)),
          fetchSite: sanitized(site),
        },
      },
      'rejected a cross-origin request made with the session cookie',
    );
    return reply.status(403).send({
      error: CSRF_ERROR,
      message: 'This request must come from the board',
    });
  });
}
