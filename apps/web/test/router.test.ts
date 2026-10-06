import { describe, expect, it, vi } from 'vitest';
import type { RouteLocationNormalized } from 'vue-router';

const { auth, beforeEach } = vi.hoisted(() => ({
  auth: { loaded: false, me: null, load: vi.fn() },
  beforeEach: vi.fn(),
}));
vi.mock('../src/stores/auth', () => ({ useAuthStore: () => auth }));
vi.mock('vue-router', () => ({ createWebHistory: vi.fn(), createRouter: () => ({ beforeEach }) }));
await import('../src/router');
const guard = beforeEach.mock.calls[0]?.[0] as (
  to: Partial<RouteLocationNormalized>,
) => Promise<unknown>;

describe('auth navigation guard', () => {
  it('propagates session load failure instead of redirecting', async () => {
    const failure = new Error('session unavailable');
    auth.load.mockRejectedValueOnce(failure);
    await expect(guard({ name: 'live', fullPath: '/' })).rejects.toBe(failure);
  });
  it('redirects to login only after a successful null session result', async () => {
    auth.load.mockResolvedValueOnce(null);
    await expect(guard({ name: 'live', fullPath: '/' })).resolves.toEqual({
      name: 'login',
      query: { next: '/' },
    });
  });

  it('keeps members out of administration routes and lets admins in', async () => {
    const me = (role: string) => ({ kind: 'user', id: 'u', role, mfaRequired: false });
    const to = { name: 'admin-users', fullPath: '/admin/users', meta: { admin: true } };
    auth.load.mockResolvedValueOnce(me('member'));
    await expect(guard(to)).resolves.toEqual({ name: 'overview' });
    auth.load.mockResolvedValueOnce(me('viewer'));
    await expect(guard(to)).resolves.toEqual({ name: 'overview' });
    auth.load.mockResolvedValueOnce(me('admin'));
    await expect(guard(to)).resolves.toBe(true);
    auth.load.mockResolvedValueOnce(me('member'));
    await expect(guard({ name: 'overview', fullPath: '/overview', meta: {} })).resolves.toBe(true);
  });
});
