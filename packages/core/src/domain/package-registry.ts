import { z } from 'zod';

/**
 * The package registry sandboxed coding runs install from (CODE_PACKAGE_REGISTRY,
 * docs/package-registry.md), for example a Verdaccio that caches npmjs and holds internal packages.
 * Keep the rules in step with the root helper (deploy/agent-sandbox/registry.mjs): it checks the
 * URL again and accepts only one listed in its own configuration.
 */
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOST_NAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** Path segments from a conservative set: the URL ends up in a systemd Environment= value. */
const REGISTRY_PATH = /^(\/[A-Za-z0-9._~-]*)*$/;

/**
 * The registry URL in the form the runner and the helper compare and pass on: scheme, host, port
 * and path ending in `/`; null when it is not acceptable (other schemes, credentials, a query or
 * fragment, an IPv6 or wildcard host, characters outside the safe set).
 */
export function normalizePackageRegistry(value: string): string | null {
  if (value.length > 512 || /[\s%"'\\$`]/.test(value)) return null;
  const url = parsedUrl(value);
  if (!url || !hostAndPathValid(url)) return null;
  const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return `${url.protocol}//${url.host}${path}`;
}

/** An http(s) URL without credentials, query or fragment, or null. */
function parsedUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.username || url.password || url.search || url.hash ? null : url;
}

function hostAndPathValid(url: URL): boolean {
  if (!IPV4.test(url.hostname) && !HOST_NAME.test(url.hostname)) return false;
  if (!REGISTRY_PATH.test(url.pathname)) return false;
  return !url.pathname.split('/').some((part) => part === '.' || part === '..');
}

/** CODE_PACKAGE_REGISTRY: unset or empty means none; otherwise a URL normalizePackageRegistry accepts. */
export const packageRegistrySchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z
    .string()
    .trim()
    .transform((value, context) => {
      const normalized = normalizePackageRegistry(value);
      if (normalized === null) {
        context.addIssue({
          code: 'custom',
          message:
            'must be an http(s) URL with an IPv4 address or host name, without credentials, query or fragment',
        });
        return z.NEVER;
      }
      return normalized;
    })
    .optional(),
);

/** CODE_PACKAGE_REGISTRY_SCOPES: npm scopes published on the registry, named in the run prompt. */
export const packageScopesSchema = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((scope) => scope.trim().toLowerCase())
      .filter((scope) => scope.length > 0),
  )
  .pipe(
    z
      .array(
        z
          .string()
          .max(64)
          .regex(/^@[a-z0-9][a-z0-9._-]*$/, 'must be an npm scope such as @acme'),
      )
      .max(20),
  );
