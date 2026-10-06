import { THEME_MODES as CORE_MODES, THEME_TEMPLATES } from '@conclavix/core';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../src/stores/auth';
import { useThemeStore } from '../src/stores/theme';
import { TEMPLATES, THEME_MODES } from '../src/theme/resolve';

const fetchMock = vi.fn<typeof fetch>();
const me = (theme?: object) =>
  new Response(
    JSON.stringify({
      kind: 'user',
      id: 'u1',
      role: 'member',
      mfaRequired: false,
      ...(theme ? { preferences: { theme } } : {}),
    }),
  );

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('theme preferences from the profile', () => {
  it('validates templates and modes against the list the API uses', () => {
    expect(TEMPLATES.map((template) => template.name)).toEqual([...THEME_TEMPLATES]);
    expect([...THEME_MODES]).toEqual([...CORE_MODES]);
  });

  const patches = () =>
    fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'PATCH')
      .map(([url, init]) => [String(url), JSON.parse(String(init?.body))]);

  it('applies the profile theme on load and adopts it on this device', async () => {
    const theme = useThemeStore();
    fetchMock.mockResolvedValueOnce(me({ template: 'neon' }));
    await useAuthStore().load();
    expect(theme.template).toBe('neon');
    expect(JSON.parse(localStorage.getItem('conclavix.theme') ?? '{}')).toMatchObject({
      template: 'neon',
    });
  });

  it('saves a signed-in choice to the profile as { template, mode }', async () => {
    const theme = useThemeStore();
    fetchMock.mockResolvedValueOnce(me({ template: 'atlas', mode: 'light' }));
    await useAuthStore().load();
    fetchMock.mockResolvedValue(new Response('{}'));
    theme.setTemplate('paper');
    theme.setMode('system');
    expect(patches()).toEqual([
      ['/api/me', { preferences: { theme: { template: 'paper', mode: 'light' } } }],
      ['/api/me', { preferences: { theme: { template: 'paper', mode: 'system' } } }],
    ]);
    expect(theme.template).toBe('paper');
  });

  it('keeps the choice on this device when saving to the profile fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const theme = useThemeStore();
    fetchMock.mockResolvedValueOnce(me());
    await useAuthStore().load();
    fetchMock.mockResolvedValue(new Response('{"error":"x"}', { status: 500 }));
    theme.setTemplate('clay');
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(theme.template).toBe('clay');
    warn.mockRestore();
  });

  it('stays local-only when signed out or signed in with the board token', async () => {
    const theme = useThemeStore();
    const auth = useAuthStore();
    fetchMock.mockResolvedValueOnce(me({ template: 'neon' }));
    await auth.load();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await auth.signOut();
    fetchMock.mockClear();
    theme.setTemplate('candy');
    expect(theme.template).toBe('candy');
    expect(patches()).toEqual([]);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ kind: 'board', id: null, role: 'owner', mfaRequired: false })),
    );
    await auth.load();
    theme.setTemplate('lux');
    expect(patches()).toEqual([]);
    expect(theme.template).toBe('lux');
  });
});
