import { isIP } from 'node:net';

/**
 * The package registry of a run (`--package-registry`, CODE_PACKAGE_REGISTRY on the runner,
 * docs/package-registry.md). Keep normalizePackageRegistry in step with
 * packages/core/src/domain/package-registry.ts.
 */
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOST_NAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const REGISTRY_PATH = /^(\/[A-Za-z0-9._~-]*)*$/;

/** The public npm registry; left out of the run's domains unless the run keeps it as fallback. */
export const PUBLIC_NPM_DOMAINS = ['registry.npmjs.org'];

/**
 * Scheme, host, port and a path ending in `/`, or null for anything else: other schemes,
 * credentials, query, fragment, IPv6 or wildcard hosts, characters a systemd Environment= value
 * would have to escape.
 */
export function normalizePackageRegistry(value) {
  if (typeof value !== 'string' || value.length > 512 || /[\s%"'\\$`]/.test(value)) return null;
  const url = parsedUrl(value);
  if (!url || !hostAndPathValid(url)) return null;
  const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return `${url.protocol}//${url.host}${path}`;
}

/** An http(s) URL without credentials, query or fragment, or null. */
function parsedUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.username || url.password || url.search || url.hash ? null : url;
}

function hostAndPathValid(url) {
  if (!IPV4.test(url.hostname) && !HOST_NAME.test(url.hostname)) return false;
  if (!REGISTRY_PATH.test(url.pathname)) return false;
  return !url.pathname.split('/').some((part) => part === '.' || part === '..');
}

/** A registry URL exactly as the configuration and the runner must write it. */
export const registryUrlValid = (value) => normalizePackageRegistry(value) === value;

export const registryHost = (url) => new URL(url).hostname;

/**
 * The private address the unit must be allowed to connect to (IPAddressAllow=), or null when the
 * registry is named by host name: the helper does not resolve names, so a registry on a private
 * network is configured by its address (docs/package-registry.md).
 */
export function registryAddress(url) {
  const host = registryHost(url);
  return isIP(host) === 4 ? host : null;
}

/**
 * Refuse a run's registry unless the root-owned configuration lists exactly that URL; the runner
 * cannot open the sandbox to any other address.
 */
export function assertRegistryAllowed(url, config) {
  if (!config.packageRegistries.includes(url)) {
    throw new Error(`package registry ${url} is not listed in packageRegistries`);
  }
}

/**
 * Check the run's registry against the configuration and open its address for the unit
 * (IPAddressAllow=, on top of the MCP addresses kept by partitionAddresses). No-op without one.
 */
export function applyRegistry(options, config) {
  if (!options.packageRegistry) return;
  assertRegistryAllowed(options.packageRegistry, config);
  const address = registryAddress(options.packageRegistry);
  if (address && !options.allowAddresses.includes(address)) options.allowAddresses.push(address);
}

/** The hosts sandboxed commands may reach: configured and run domains, the run's registry. */
export function sandboxDomains(config, options) {
  const domains = [...config.allowedDomains, ...(options.extraDomains ?? [])];
  if (!options.packageRegistry) return [...new Set(domains)].sort();
  const kept = options.registryFallback
    ? domains
    : domains.filter((domain) => !PUBLIC_NPM_DOMAINS.includes(domain));
  return [...new Set([...kept, registryHost(options.packageRegistry)])].sort();
}

/**
 * Environment= entries pointing npm, pnpm (npm_config_registry) and yarn 1 and 2+ at the
 * registry; yarn 2+ also needs plain-http hosts whitelisted.
 */
export function registryEnvironment(url) {
  if (!url) return [];
  const entries = [
    ['npm_config_registry', url],
    ['YARN_REGISTRY', url],
    ['YARN_NPM_REGISTRY_SERVER', url],
  ];
  if (url.startsWith('http:')) entries.push(['YARN_UNSAFE_HTTP_WHITELIST', registryHost(url)]);
  return entries.map(([name, value]) => `Environment=${name}=${value}`);
}
