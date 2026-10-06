import http from 'node:http';
import https from 'node:https';
import { AppError } from '../../errors.js';
import { assertSafeDirectoryUrl, guardedLookup } from './net-guard.js';

export interface HttpResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface HttpRequest {
  headers: Record<string, string>;
  timeoutMs: number;
}

/** A GET returning the response text; adapters depend on this, tests replace it. */
export type HttpTransport = (url: URL, request: HttpRequest) => Promise<HttpResponse>;

export interface TransportOptions {
  /** Lift the private-network and https rules (SKILL_SOURCES_ALLOW_PRIVATE, tests only). */
  allowPrivate: boolean;
  /** Responses larger than this are rejected rather than buffered. */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

export const directoryTimeout = (): AppError =>
  new AppError(504, 'directory_timeout', 'The directory did not answer in time');

export const directoryUnavailable = (): AppError =>
  new AppError(502, 'directory_unavailable', 'The directory could not be reached');

function flatHeaders(raw: http.IncomingHttpHeaders): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]),
  );
}

/**
 * GET over node:http(s) with the SSRF guard on the DNS lookup, a hard timeout, a size cap and no
 * redirects. Errors never carry the request headers, so the API key cannot leak through them.
 */
export function createGuardedTransport(options: TransportOptions): HttpTransport {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  return (url, request) =>
    new Promise<HttpResponse>((resolve, reject) => {
      let safe: URL;
      try {
        safe = assertSafeDirectoryUrl(url, options.allowPrivate);
      } catch (error) {
        reject(error);
        return;
      }
      const client = safe.protocol === 'https:' ? https : http;
      let settled = false;
      const controller = new AbortController();
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(() => {
        fail(directoryTimeout());
        controller.abort();
      }, request.timeoutMs);
      const req = client.request(
        safe,
        {
          method: 'GET',
          headers: request.headers,
          agent: false,
          signal: controller.signal,
          ...(options.allowPrivate ? {} : { lookup: guardedLookup }),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              res.destroy();
              fail(
                new AppError(
                  502,
                  'directory_invalid_response',
                  'The directory answer is too large',
                ),
              );
              return;
            }
            chunks.push(chunk);
          });
          res.on('error', () => fail(directoryUnavailable()));
          res.on('end', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({
              status: res.statusCode ?? 0,
              headers: flatHeaders(res.headers),
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        },
      );
      req.on('error', (error) => {
        fail(error instanceof AppError ? error : directoryUnavailable());
      });
      req.end();
    });
}
