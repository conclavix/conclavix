import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AppError } from '../../errors.js';
import { isBlockedAddress, isBlockedHost } from '../skill-sources/net-guard.js';

export const connectionAddressBlocked = (): AppError =>
  new AppError(
    422,
    'connection_address_blocked',
    'The URL points to a private or local network address; an owner can allow private networks for this connection',
  );

/**
 * Check a connection URL before it is stored or used: http(s) without credentials in it; https
 * and a public host unless the connection allows private networks (an owner's choice).
 */
export function assertSafeConnectionUrl(raw: string, allowPrivate: boolean): URL {
  // claude expands ${NAME} in MCP server URLs from its environment: run tokens, other headers.
  if (raw.includes('$')) {
    throw new AppError(422, 'connection_url_invalid', 'The URL must not contain $');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(422, 'connection_url_invalid', 'The URL is not valid');
  }
  if (url.username || url.password) {
    throw new AppError(422, 'connection_url_invalid', 'The URL must not carry credentials');
  }
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) {
    throw new AppError(
      422,
      'connection_url_invalid',
      allowPrivate ? 'The URL must use http or https' : 'The URL must use https',
    );
  }
  if (!allowPrivate && isBlockedHost(url.hostname)) throw connectionAddressBlocked();
  return url;
}

/** The addresses a URL's host resolves to (the literal itself for an IP). */
export async function resolveHost(url: URL): Promise<string[]> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0) return [host];
  const found = await lookup(host, { all: true, verbatim: true });
  return found.map((entry) => entry.address);
}

/**
 * Resolve the URL's host for a run, where the agent's claude connects by itself: refused when a
 * public-only connection resolves to a private address. Returns the private addresses (to be
 * allowed in the sandbox) of a connection that may use private networks.
 */
export async function privateAddressesFor(url: URL, allowPrivate: boolean): Promise<string[]> {
  const addresses = await resolveHost(url);
  const blocked = addresses.filter((address) => isBlockedAddress(address));
  if (blocked.length > 0 && !allowPrivate) throw connectionAddressBlocked();
  return blocked;
}
