import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, AuthError, MfaRequiredError, tokenStore } from '../src/api/client';
import { useAuthStore } from '../src/stores/auth';

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('API response handling', () => {
  it.each([204, 200])('accepts an empty %s response', async (status) => {
    fetchMock.mockResolvedValue(new Response(null, { status }));
    await expect(api('/users/1', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('parses JSON and propagates malformed JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"items":[]}'));
    await expect(api('/users')).resolves.toEqual({ items: [] });
    fetchMock.mockResolvedValueOnce(new Response('invalid JSON'));
    await expect(api('/users')).rejects.toBeInstanceOf(SyntaxError);
  });

  it.each([
    '<html>Bad gateway</html>',
    '{invalid',
    'null',
    '42',
    '"unavailable"',
    '[]',
    '{"error":{},"code":42,"message":[]}',
  ])('preserves the status for an unusable error body: %s', async (body) => {
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 502 }));
    await expect(api('/users')).rejects.toMatchObject({
      name: 'ApiError',
      status: 502,
      code: 'error',
      message: 'request failed with 502',
    });
  });

  it('uses only string error fields', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{"error":{},"code":"unavailable","message":"Try later"}', { status: 503 }),
    );
    await expect(api('/users')).rejects.toMatchObject({
      status: 503,
      code: 'unavailable',
      message: 'Try later',
    });
  });

  it('preserves HTTP errors, including an empty error response', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    await expect(api('/users')).rejects.toMatchObject({ status: 500, code: 'error' });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(api('/users')).rejects.toBeInstanceOf(AuthError);
    fetchMock.mockResolvedValueOnce(
      new Response('{"error":"mfa_enrollment_required"}', { status: 403 }),
    );
    await expect(api('/users')).rejects.toBeInstanceOf(MfaRequiredError);
  });
});

describe('sign out', () => {
  it('keeps the current user and propagates a failed sign-out, then clears it on success', async () => {
    const auth = useAuthStore();
    auth.me = { kind: 'user', id: '1', role: 'member', mfaRequired: false };
    const clear = vi.spyOn(tokenStore, 'clear');
    fetchMock.mockResolvedValueOnce(new Response('{"message":"Unavailable"}', { status: 503 }));
    await expect(auth.signOut()).rejects.toBeInstanceOf(ApiError);
    expect(auth.me?.id).toBe('1');
    expect(clear).toHaveBeenCalledOnce();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await auth.signOut();
    expect(auth.me).toBeNull();
  });
});

describe('sign in', () => {
  it('clears the previous token before signing in and loading the new user', async () => {
    sessionStorage.setItem('conclavix.apiToken', 'previous-user-token');
    const user = { kind: 'user', id: 'new-user', role: 'member', mfaRequired: false };
    fetchMock.mockImplementation(async (path, init) => {
      expect(tokenStore.get()).toBeNull();
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      return Response.json(path === '/api/me' ? user : {});
    });
    const auth = useAuthStore();
    await expect(auth.signIn('new@example.com', 'password')).resolves.toBe('ok');
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/auth/sign-in/email',
      '/api/me',
    ]);
    expect(auth.me).toEqual(user);
  });

  it('recognizes a non-JSON rate limit response', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Too many requests', { status: 429 }));
    await expect(useAuthStore().signIn('user@example.com', 'password')).resolves.toBe('limited');
  });
});
