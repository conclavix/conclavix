import { createHmac } from 'node:crypto';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { BOARD_URL, type TestContext } from './helpers.js';

export const PASSWORD = 'correct horse battery staple';

/** Create a user through the API with the board token and return its id. */
export async function createUser(
  ctx: TestContext,
  email: string,
  role: 'owner' | 'admin' | 'member' | 'viewer',
  password = PASSWORD,
): Promise<string> {
  const response = await ctx.request({
    method: 'POST',
    url: '/api/users',
    payload: { email, name: email.split('@')[0], role, password },
  });
  if (response.statusCode !== 201) {
    throw new Error(`createUser failed: ${response.statusCode} ${response.body}`);
  }
  return response.json().user.id as string;
}

/** Join the name=value parts of every set-cookie header into one cookie header. */
export function cookiesOf(response: LightMyRequestResponse, previous = ''): string {
  const jar = new Map<string, string>();
  for (const part of previous.split('; ').filter(Boolean)) {
    const [name, ...rest] = part.split('=');
    jar.set(name ?? '', rest.join('='));
  }
  const raw = response.headers['set-cookie'];
  for (const header of Array.isArray(raw) ? raw : raw ? [raw] : []) {
    const [pair] = header.split(';');
    const [name, ...rest] = (pair ?? '').split('=');
    const value = rest.join('=');
    if (value === '' || /max-age=0/i.test(header)) jar.delete(name ?? '');
    else jar.set(name ?? '', value);
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** A request from the board origin with a cookie and without the board token. */
export function asBrowser(
  ctx: TestContext,
  cookie: string,
  options: InjectOptions,
): Promise<LightMyRequestResponse> {
  return ctx.app.inject({
    ...options,
    headers: { origin: BOARD_URL, ...(cookie ? { cookie } : {}), ...options.headers },
  });
}

export async function signIn(
  ctx: TestContext,
  email: string,
  password = PASSWORD,
): Promise<{ response: LightMyRequestResponse; cookie: string }> {
  const response = await asBrowser(ctx, '', {
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email, password },
  });
  return { response, cookie: cookiesOf(response) };
}

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of input.replace(/=+$/, '').toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  }
  const bytes = bits.match(/.{8}/g) ?? [];
  return Buffer.from(bytes.map((byte) => parseInt(byte, 2)));
}

/** RFC 6238 code for the secret in an otpauth URI. */
export function totp(uri: string, at = Date.now()): string {
  const url = new URL(uri);
  const secret = base32Decode(url.searchParams.get('secret') ?? '');
  const digits = Number(url.searchParams.get('digits') ?? 6);
  const period = Number(url.searchParams.get('period') ?? 30);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / period)));
  const hmac = createHmac('sha1', secret).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return code.toString().padStart(digits, '0');
}
