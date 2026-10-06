import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, AuthError } from '../src/api/client';
import { useApiTokensStore } from '../src/stores/api-tokens';
import { useAuthStore } from '../src/stores/auth';
import {
  SESSION_NOT_FRESH_MESSAGE,
  currentFirst,
  problemText,
  useProfileStore,
} from '../src/stores/profile';

vi.mock('../src/stores/theme', () => ({
  useThemeStore: () => ({ setPersister: vi.fn(), applyPreferences: vi.fn() }),
}));

const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const token = {
  id: 't1',
  name: 'ci',
  prefix: 'cvx_abcd',
  createdAt: '2026-10-01T00:00:00.000Z',
  expiresAt: null,
  lastUsedAt: null,
};
const session = (id: string, createdAt: string) => ({
  id,
  token: `tok-${id}`,
  createdAt,
  expiresAt: '2026-11-01T00:00:00.000Z',
  ipAddress: '127.0.0.1',
  userAgent: 'curl/8',
});
const me = {
  kind: 'user',
  id: 'u1',
  name: 'Alice',
  email: 'm@example.com',
  role: 'owner',
  mfaRequired: false,
  twoFactorEnabled: false,
};

const ROUTES: Record<string, { body: unknown; status?: number }> = {
  'GET /api/me': { body: me },
  'PATCH /api/me': { body: { id: 'u1', name: 'Neo' } },
  'GET /api/me/tokens': { body: { items: [token] } },
  'POST /api/me/tokens': { body: { ...token, id: 't2', token: 'cvx_secret' }, status: 201 },
  'GET /api/auth/list-sessions': {
    body: [
      session('old', '2026-09-01T00:00:00.000Z'),
      session('mine', '2026-09-15T00:00:00.000Z'),
      session('new', '2026-10-01T00:00:00.000Z'),
    ],
  },
  'GET /api/auth/get-session': { body: { session: { id: 'mine' }, user: {} } },
};

describe('profile store', () => {
  let calls: { url: string; method: string; body?: unknown }[];
  let responder: (url: string, method: string) => Response | Promise<Response> | undefined;

  beforeEach(() => {
    setActivePinia(createPinia());
    calls = [];
    responder = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? 'GET';
        calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
        const custom = responder(url, method);
        if (custom) return custom;
        if (method === 'DELETE') return json(null, 204);
        const route = ROUTES[`${method} ${url}`];
        if (route) return json(route.body, route.status);
        return json({ status: true });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renames through PATCH /api/me and updates the signed-in user and the name lookup', async () => {
    const auth = useAuthStore();
    await auth.load();
    await useProfileStore().rename('  Neo ');
    expect(calls.at(-1)).toMatchObject({ url: '/api/me', method: 'PATCH', body: { name: 'Neo' } });
    expect(auth.me?.name).toBe('Neo');
    expect(auth.names['u1']).toBe('Neo');
  });

  it('keeps the avatar URL on the signed-in user', async () => {
    const auth = useAuthStore();
    await auth.load();
    auth.patchMe({ avatarUrl: '/api/avatars/user/u1?v=e1' });
    expect(auth.me?.avatarUrl).toBe('/api/avatars/user/u1?v=e1');
  });

  it('forgets sessions and tokens when the user signs out', async () => {
    const auth = useAuthStore();
    await auth.load();
    const profile = useProfileStore();
    const apiTokens = useApiTokensStore();
    await profile.loadSessions();
    await apiTokens.load();
    expect(profile.sessions).toHaveLength(3);
    await auth.signOut();
    await nextTick();
    expect(profile.sessions).toEqual([]);
    expect(apiTokens.tokens).toEqual([]);
    expect(profile.currentSessionId).toBeNull();
  });

  it('ignores session and token lists that arrive after a sign-out', async () => {
    const auth = useAuthStore();
    await auth.load();
    const profile = useProfileStore();
    const apiTokens = useApiTokensStore();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    responder = (url, method) => {
      if (url !== '/api/auth/list-sessions' && !(url === '/api/me/tokens' && method === 'GET'))
        return undefined;
      return gate.then(() => ROUTES[`GET ${url}`]).then((route) => json(route?.body));
    };
    const sessions = profile.loadSessions();
    const tokens = apiTokens.load();
    await auth.signOut();
    release();
    await Promise.all([sessions, tokens]);
    expect(profile.sessions).toEqual([]);
    expect(apiTokens.tokens).toEqual([]);
  });

  it('creates a token, keeps only its summary in the list, and revokes it', async () => {
    const profile = useApiTokensStore();
    await profile.load();
    const created = await profile.create(' deploy ', 30);
    expect(calls.at(-1)).toMatchObject({
      url: '/api/me/tokens',
      method: 'POST',
      body: { name: 'deploy', expiresInDays: 30 },
    });
    expect(created.token).toBe('cvx_secret');
    expect(profile.tokens.map((item) => item.id)).toEqual(['t2', 't1']);
    expect(JSON.stringify(profile.tokens)).not.toContain('cvx_secret');
    await profile.create('forever');
    expect(calls.at(-1)?.body).toEqual({ name: 'forever' });
    await profile.revoke('t1');
    expect(calls.at(-1)).toMatchObject({ url: '/api/me/tokens/t1', method: 'DELETE' });
    expect(profile.tokens.map((item) => item.id)).toEqual(['t2']);
  });

  it('lists sessions with the current one first and revokes by token', async () => {
    const profile = useProfileStore();
    await profile.loadSessions();
    expect(profile.currentSessionId).toBe('mine');
    expect(profile.sessions.map((item) => item.id)).toEqual(['mine', 'new', 'old']);
    const newest = profile.sessions[1];
    if (!newest) throw new Error('missing session');
    await profile.revokeSession(newest);
    expect(calls.at(-1)).toMatchObject({
      url: '/api/auth/revoke-session',
      method: 'POST',
      body: { token: 'tok-new' },
    });
    expect(profile.sessions.map((item) => item.id)).toEqual(['mine', 'old']);
    await profile.revokeOtherSessions();
    expect(calls.at(-1)).toMatchObject({ url: '/api/auth/revoke-other-sessions' });
    expect(profile.sessions.map((item) => item.id)).toEqual(['mine']);
  });

  it('changes the password and reloads sessions when the others are signed out', async () => {
    const profile = useProfileStore();
    await profile.changePassword('old-password!', 'new-password-123', true);
    expect(calls[0]).toMatchObject({
      url: '/api/auth/change-password',
      body: {
        currentPassword: 'old-password!',
        newPassword: 'new-password-123',
        revokeOtherSessions: true,
      },
    });
    expect(calls.some((call) => call.url === '/api/auth/list-sessions')).toBe(true);
    calls = [];
    await profile.changePassword('a', 'b', false);
    expect(calls.map((call) => call.url)).toEqual(['/api/auth/change-password']);
  });

  it('forgets the replaced sessions when the reload after a password change fails', async () => {
    const profile = useProfileStore();
    await profile.loadSessions();
    responder = (url) => (url === '/api/auth/list-sessions' ? json({}, 503) : undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await profile.changePassword('old-password!', 'new-password-123', true);
    expect(profile.sessions).toEqual([]);
    expect(profile.currentSessionId).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('confirms and disables 2FA, refreshing the signed-in user each time', async () => {
    const auth = useAuthStore();
    const profile = useProfileStore();
    responder = (url) =>
      url === '/api/auth/two-factor/enable'
        ? json({ totpURI: 'otpauth://totp/x?secret=ABC', backupCodes: ['a', 'b'] })
        : undefined;
    expect(await profile.enableTwoFactor('pw')).toMatchObject({ backupCodes: ['a', 'b'] });
    await profile.confirmTwoFactor(' 123456 ');
    expect(calls.find((call) => call.url === '/api/auth/two-factor/verify-totp')?.body).toEqual({
      code: '123456',
    });
    expect(auth.me?.id).toBe('u1');
    calls = [];
    await profile.disableTwoFactor('pw');
    expect(calls.map((call) => call.url)).toEqual(['/api/auth/two-factor/disable', '/api/me']);
  });

  it('returns fresh recovery codes', async () => {
    responder = (url) =>
      url === '/api/auth/two-factor/generate-backup-codes'
        ? json({ status: true, backupCodes: ['x1', 'x2'] })
        : undefined;
    expect(await useProfileStore().generateBackupCodes('pw')).toEqual(['x1', 'x2']);
    expect(calls[0]?.body).toEqual({ password: 'pw' });
  });
});

describe('problemText', () => {
  it('turns API failures into readable text', () => {
    expect(problemText(new ApiError('Invalid password', 400, 'INVALID_PASSWORD'))).toBe(
      'Invalid password',
    );
    expect(problemText(new ApiError('x', 429))).toMatch(/Too many attempts/);
    expect(problemText(new ApiError('x', 403, 'SESSION_NOT_FRESH'))).toBe(
      SESSION_NOT_FRESH_MESSAGE,
    );
    expect(problemText(new AuthError(), true)).toMatch(/code is not valid/);
    expect(problemText(new AuthError())).toBe('not signed in');
  });

  it('orders the current session first', () => {
    const list = [
      { id: 'a', token: 'a', createdAt: '1', expiresAt: '' },
      { id: 'b', token: 'b', createdAt: '2', expiresAt: '' },
    ];
    expect(currentFirst(list, 'a').map((item) => item.id)).toEqual(['a', 'b']);
    expect(currentFirst(list, null).map((item) => item.id)).toEqual(['b', 'a']);
  });
});
