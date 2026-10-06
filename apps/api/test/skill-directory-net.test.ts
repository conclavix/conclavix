import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import { createGuardedTransport } from '../src/modules/skill-sources/http.js';
import {
  assertSafeDirectoryUrl,
  guardedLookup,
  isBlockedAddress,
} from '../src/modules/skill-sources/net-guard.js';

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return error instanceof AppError ? error.code : String(error);
  }
  return undefined;
};

describe('skill directory SSRF guard', () => {
  it('blocks private, loopback, link-local, reserved and mapped addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.50',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '::ffff:8.8.8.8',
      '64:ff9b::a00:1',
      'not-an-ip',
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
    for (const address of ['8.8.8.8', '104.21.0.1', '2606:4700::1111', '2001:4860:4860::8888']) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it('accepts only public https URLs unless the test flag is set', () => {
    expect(
      codeOf(() => assertSafeDirectoryUrl('https://www.skillsdirectory.com/api/v1', false)),
    ).toBeUndefined();
    expect(codeOf(() => assertSafeDirectoryUrl('https://8.8.8.8/api', false))).toBeUndefined();
    expect(
      codeOf(() => assertSafeDirectoryUrl('http://www.skillsdirectory.com/api/v1', false)),
    ).toBe('directory_url_invalid');
    for (const url of [
      'https://127.0.0.1/api',
      'https://[::1]/api',
      'https://10.0.0.5/api',
      'https://169.254.169.254/latest',
      'https://localhost/api',
      'https://intranet/api',
      'https://box.local/api',
      'https://svc.internal/api',
    ]) {
      expect(
        codeOf(() => assertSafeDirectoryUrl(url, false)),
        url,
      ).toBe('directory_address_blocked');
    }
    expect(codeOf(() => assertSafeDirectoryUrl('https://user:pw@example.com/', false))).toBe(
      'directory_url_invalid',
    );
    expect(codeOf(() => assertSafeDirectoryUrl('http://127.0.0.1:9/api', true))).toBeUndefined();
    expect(codeOf(() => assertSafeDirectoryUrl('ftp://127.0.0.1/api', true))).toBe(
      'directory_url_invalid',
    );
  });

  it('refuses a host name that resolves to a blocked address', async () => {
    const error = await new Promise<unknown>((resolve) =>
      guardedLookup('localhost', {}, (failure) => resolve(failure)),
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('directory_address_blocked');
  });
});

describe('guarded directory transport', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/slow') return;
      if (request.url === '/big') {
        response.end('x'.repeat(4096));
        return;
      }
      if (request.url === '/redirect') {
        response.writeHead(302, { location: 'http://169.254.169.254/' });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json', 'x-test': 'yes' });
      response.end(JSON.stringify({ ua: request.headers['user-agent'] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const request = { headers: { 'user-agent': 'Conclavix/test' }, timeoutMs: 2000 };

  it('never connects to a loopback server without the test flag', async () => {
    const transport = createGuardedTransport({ allowPrivate: false });
    await expect(transport(new URL(`${base}/ok`), request)).rejects.toMatchObject({
      code: 'directory_url_invalid',
    });
    const https = new URL(base.replace('http:', 'https:'));
    await expect(transport(https, request)).rejects.toMatchObject({
      code: 'directory_address_blocked',
    });
  });

  it('fetches with the flag, without following redirects', async () => {
    const transport = createGuardedTransport({ allowPrivate: true });
    const ok = await transport(new URL(`${base}/ok`), request);
    expect(ok.status).toBe(200);
    expect(ok.headers['x-test']).toBe('yes');
    expect(JSON.parse(ok.body)).toEqual({ ua: 'Conclavix/test' });
    expect((await transport(new URL(`${base}/redirect`), request)).status).toBe(302);
  });

  it('times out, caps the size and reports unreachable hosts', async () => {
    const transport = createGuardedTransport({ allowPrivate: true, maxBytes: 1024 });
    await expect(
      transport(new URL(`${base}/slow`), { ...request, timeoutMs: 100 }),
    ).rejects.toMatchObject({ statusCode: 504, code: 'directory_timeout' });
    await expect(transport(new URL(`${base}/big`), request)).rejects.toMatchObject({
      code: 'directory_invalid_response',
    });
    await expect(transport(new URL('http://127.0.0.1:9/'), request)).rejects.toMatchObject({
      statusCode: 502,
      code: 'directory_unavailable',
    });
  });
});
