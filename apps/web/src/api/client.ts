import type { z } from 'zod';

const TOKEN_KEY = 'conclavix.apiToken';

export class AuthError extends Error {
  /** Signal a missing or expired sign-in without exposing any credential. */
  constructor() {
    super('not signed in');
    this.name = 'AuthError';
  }
}

export class MfaRequiredError extends Error {
  /** Signal that the session is held at the two-factor enrolment step. */
  constructor() {
    super('two-factor authentication must be set up first');
    this.name = 'MfaRequiredError';
  }
}

/** A non-2xx board API response, keeping the server's error code and details. */
export class ApiError extends Error {
  /** Keep the HTTP status available to callers for endpoint-specific recovery. */
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** An optional personal API token; the browser normally authenticates with its session cookie. */
export const tokenStore = {
  /** Read the token, returning null when browser storage is unavailable. */
  get(): string | null {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  /** Store a token for this tab; tolerate browsers that deny storage access. */
  set(token: string): void {
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
    } catch {
      return;
    }
  },
  /** Remove the token when possible, including after an unauthorized response. */
  clear(): void {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      return;
    }
  },
};

/** Headers for an API call: the stored bearer token, if any, alongside the session cookie. */
export function authHeaders(): Record<string, string> {
  const token = tokenStore.get();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** Call /api with the session cookie; 401 throws AuthError, a pending MFA setup MfaRequiredError. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
      ...authHeaders(),
    },
  });
  if (response.status === 401) {
    tokenStore.clear();
    throw new AuthError();
  }
  if (response.status === 204) return undefined as T;
  const body = await responseBody(response);
  const error =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  if (response.status === 403 && error['error'] === 'mfa_enrollment_required') {
    throw new MfaRequiredError();
  }
  if (!response.ok) {
    throw new ApiError(
      typeof error['message'] === 'string'
        ? error['message']
        : `request failed with ${response.status}`,
      response.status,
      typeof error['error'] === 'string'
        ? error['error']
        : typeof error['code'] === 'string'
          ? error['code']
          : 'error',
      error['details'],
    );
  }
  return body as T;
}

/** Malformed error bodies must not hide the HTTP status; successful JSON must still be valid. */
async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : undefined;
  } catch (error) {
    if (response.ok) throw error;
    return undefined;
  }
}

/** Parse server JSON before exposing it to a schema-aware caller. */
export async function apiValidated<T>(
  schema: z.ZodType<T>,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  return schema.parse(await api<unknown>(path, init));
}
