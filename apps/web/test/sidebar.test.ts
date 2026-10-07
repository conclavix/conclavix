import { SIDEBAR_MODES } from '@conclavix/core';
import { createPinia, setActivePinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import { createVuetify } from 'vuetify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SidebarPinToggle from '../src/components/SidebarPinToggle.vue';
import { useAuthStore } from '../src/stores/auth';
import { SIDEBAR_STORAGE_KEY, isSidebarMode, useSidebarStore } from '../src/stores/sidebar';

const fetchMock = vi.fn<typeof fetch>();
const me = (sidebar?: string) =>
  new Response(
    JSON.stringify({
      kind: 'user',
      id: 'u1',
      role: 'member',
      mfaRequired: false,
      preferences: { theme: {}, ...(sidebar ? { sidebar } : {}) },
    }),
  );
const patches = () =>
  fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'PATCH')
    .map(([url, init]) => [String(url), JSON.parse(String(init?.body))]);

function mockWidth(wide: boolean) {
  const listeners: ((event: { matches: boolean }) => void)[] = [];
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: wide,
      addEventListener: (_: string, listener: (event: { matches: boolean }) => void) =>
        listeners.push(listener),
    })),
  );
  return (matches: boolean) => listeners.forEach((listener) => listener({ matches }));
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('sidebar mode', () => {
  it('accepts exactly the modes the API stores', () => {
    expect(SIDEBAR_MODES.every(isSidebarMode)).toBe(true);
    expect(isSidebarMode('floating')).toBe(false);
  });

  it('starts as a rail and restores the choice stored on this device', () => {
    expect(useSidebarStore().mode).toBe('rail');
    localStorage.setItem(SIDEBAR_STORAGE_KEY, 'pinned');
    setActivePinia(createPinia());
    expect(useSidebarStore().pinned).toBe(true);
    localStorage.setItem(SIDEBAR_STORAGE_KEY, 'garbage');
    setActivePinia(createPinia());
    expect(useSidebarStore().mode).toBe('rail');
  });

  it('keeps the rail on narrow screens even when pinned', () => {
    const resize = mockWidth(false);
    const sidebar = useSidebarStore();
    sidebar.setMode('pinned');
    expect(sidebar.pinned).toBe(false);
    resize(true);
    expect(sidebar.pinned).toBe(true);
  });

  it('works on this device only when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const sidebar = useSidebarStore();
    sidebar.toggle();
    expect(sidebar.pinned).toBe(true);
    vi.restoreAllMocks();
  });

  it('applies the profile choice on sign-in and saves new choices to the profile', async () => {
    const sidebar = useSidebarStore();
    fetchMock.mockResolvedValueOnce(me('pinned'));
    await useAuthStore().load();
    expect(sidebar.mode).toBe('pinned');
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('pinned');
    fetchMock.mockResolvedValue(new Response('{}'));
    sidebar.toggle();
    expect(sidebar.mode).toBe('rail');
    expect(patches()).toEqual([['/api/me', { preferences: { sidebar: 'rail' } }]]);
  });

  it('keeps the device choice when the profile has none or after sign-out', async () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, 'pinned');
    setActivePinia(createPinia());
    const sidebar = useSidebarStore();
    fetchMock.mockResolvedValueOnce(me());
    await useAuthStore().load();
    expect(sidebar.mode).toBe('pinned');
    fetchMock.mockResolvedValue(new Response('{}'));
    await useAuthStore().signOut();
    fetchMock.mockClear();
    sidebar.toggle();
    expect(patches()).toEqual([]);
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('rail');
  });
});

describe('pin toggle', () => {
  const mount = async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const app = createApp(SidebarPinToggle).use(createPinia()).use(createVuetify());
    app.mount(root);
    await nextTick();
    return { root, app };
  };

  it('pins and unpins the sidebar and says which it will do', async () => {
    const { root, app } = await mount();
    const button = () => root.querySelector<HTMLElement>('[data-testid="sidebar-pin"]');
    expect(button()?.textContent).toContain('Pin sidebar');
    expect(button()?.getAttribute('aria-pressed')).toBe('false');
    button()?.click();
    await nextTick();
    expect(button()?.textContent).toContain('Unpin sidebar');
    expect(button()?.getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('pinned');
    app.unmount();
    root.remove();
  });

  it('is hidden on narrow screens, where the drawer stays a rail', async () => {
    mockWidth(false);
    const { root, app } = await mount();
    expect(root.querySelector('[data-testid="sidebar-pin"]')).toBeNull();
    app.unmount();
    root.remove();
  });
});
