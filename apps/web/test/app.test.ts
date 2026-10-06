import { createApp, nextTick, type App as VueApp } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.vue';

const { auth, live, push } = vi.hoisted(() => ({
  auth: { signedIn: true, loadNames: vi.fn(), signOut: vi.fn() },
  live: { status: 'offline', load: vi.fn(), connect: vi.fn(), disconnect: vi.fn() },
  push: vi.fn(),
}));
vi.mock('../src/stores/auth', () => ({ useAuthStore: () => auth }));
vi.mock('../src/stores/live', () => ({ useLiveStore: () => live }));
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }));
vi.mock('../src/stores/theme', () => ({
  useThemeStore: () => ({ resolved: { name: 'atlas' } }),
}));
vi.mock('vuetiwatch', () => ({
  useVuetiwatch: () => ({ current: { value: { name: 'atlas' } }, change: vi.fn() }),
}));
vi.mock('../src/components/HeaderStatus.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/UserMenu.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/ThemeToggle.vue', () => ({ default: { render: () => null } }));
vi.mock('vuetify/components/VApp', () => ({ VApp: { render: () => null } }));
vi.mock('vuetify/components/VNavigationDrawer', () => ({
  VNavigationDrawer: { render: () => null },
}));
vi.mock('vuetify/components/VList', () => ({
  VList: { render: () => null },
  VListItem: { render: () => null },
}));
vi.mock('vuetify/components/VAppBar', () => ({
  VAppBar: { render: () => null },
  VAppBarTitle: { render: () => null },
}));
vi.mock('vuetify/components/VChip', () => ({ VChip: { render: () => null } }));
vi.mock('vuetify/components/VBtn', () => ({ VBtn: { render: () => null } }));
vi.mock('vuetify/components/VMain', () => ({ VMain: { render: () => null } }));
let app: VueApp;
const mount = () => {
  auth.loadNames.mockResolvedValueOnce(undefined);
  app = createApp(App);
  app.config.warnHandler = () => undefined;
  app.mount(document.createElement('div'));
};
const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
};
afterEach(() => {
  app?.unmount();
  vi.resetAllMocks();
});

describe('signed-in initialization', () => {
  it('awaits login navigation after a failed live load and never connects', async () => {
    live.load.mockRejectedValue(new Error('offline'));
    let finishSignOut: (() => void) | undefined;
    auth.signOut.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishSignOut = resolve;
        }),
    );
    mount();
    await flush();
    expect(auth.signOut).toHaveBeenCalledOnce();
    expect(push).not.toHaveBeenCalled();
    expect(live.connect).not.toHaveBeenCalled();
    finishSignOut?.();
    await flush();
    expect(push).toHaveBeenCalledWith({ name: 'login' });
    expect(live.connect).not.toHaveBeenCalled();
  });

  it('connects after a successful live load even when names fail', async () => {
    live.load.mockResolvedValue(undefined);
    auth.loadNames.mockRejectedValueOnce(new Error('names unavailable'));
    mount();
    await flush();
    expect(live.connect).toHaveBeenCalledOnce();
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});
