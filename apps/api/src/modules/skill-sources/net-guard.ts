import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { AppError } from '../../errors.js';

/**
 * Directory requests are made by the server on behalf of an admin-supplied URL, so they must not
 * reach the instance's own network (SSRF). Addresses that are private, loopback, link-local,
 * shared, reserved, documentation or multicast are refused, both as IP literals in the URL and as
 * the result of the DNS lookup made for the actual connection (which also covers DNS rebinding).
 */
const BLOCKED_V4 = new BlockList();
const BLOCKED_V6 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED_V4.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED_V6.addSubnet(network, prefix, 'ipv6');
}

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

/** True for an address the server must not connect to on behalf of a directory source. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return BLOCKED_V4.check(address, 'ipv4');
  if (family === 6) return /^::ffff:/i.test(address) || BLOCKED_V6.check(address, 'ipv6');
  return true;
}

export const addressBlocked = (): AppError =>
  new AppError(
    422,
    'directory_address_blocked',
    'The directory URL points to a private or local network address',
  );

/**
 * Check a directory base URL before it is stored or called: https only and no private host,
 * unless `allowPrivate` (the SKILL_SOURCES_ALLOW_PRIVATE test flag) lifts both rules.
 */
export function assertSafeDirectoryUrl(raw: string | URL, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = typeof raw === 'string' ? new URL(raw) : raw;
  } catch {
    throw new AppError(422, 'directory_url_invalid', 'The directory URL is not a valid URL');
  }
  if (url.username || url.password) {
    throw new AppError(
      422,
      'directory_url_invalid',
      'The directory URL must not carry credentials',
    );
  }
  if (allowPrivate) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new AppError(422, 'directory_url_invalid', 'The directory URL must use https');
    }
    return url;
  }
  if (url.protocol !== 'https:') {
    throw new AppError(422, 'directory_url_invalid', 'The directory URL must use https');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host) !== 0) {
    if (isBlockedAddress(host)) throw addressBlocked();
    return url;
  }
  if (
    host === 'localhost' ||
    !host.includes('.') ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    throw addressBlocked();
  }
  return url;
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A `lookup` for http(s).request that resolves like the default one but fails when any resolved
 * address is blocked, so the connection only ever goes to an address that was checked.
 */
export function guardedLookup(
  hostname: string,
  options: LookupOptions,
  callback: LookupCallback,
): void {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, []);
      return;
    }
    const list = addresses;
    if (list.length === 0 || list.some((entry) => isBlockedAddress(entry.address))) {
      callback(addressBlocked() as unknown as NodeJS.ErrnoException, []);
      return;
    }
    if (options.all) {
      callback(null, list);
      return;
    }
    const first = list[0] as LookupAddress;
    callback(null, first.address, first.family);
  });
}
