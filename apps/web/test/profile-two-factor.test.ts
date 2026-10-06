import { createPinia, setActivePinia } from 'pinia';
import { createApp, nextTick, type App } from 'vue';
import { createVuetify } from 'vuetify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProfileTwoFactor from '../src/components/profile/ProfileTwoFactor.vue';
import { useAuthStore, type Me } from '../src/stores/auth';

vi.mock('../src/stores/theme', () => ({
  useThemeStore: () => ({ setPersister: vi.fn(), applyPreferences: vi.fn() }),
}));

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

describe('two-factor card', () => {
  let app: App;
  let root: HTMLDivElement;

  const mount = async (me: Partial<Me>): Promise<void> => {
    const pinia = createPinia();
    setActivePinia(pinia);
    useAuthStore().me = {
      kind: 'user',
      id: 'u1',
      role: 'owner',
      mfaRequired: false,
      ...me,
    } as Me;
    root = document.createElement('div');
    document.body.append(root);
    app = createApp(ProfileTwoFactor).use(pinia).use(createVuetify());
    app.mount(root);
    await flush();
  };
  const byTestId = (id: string) => root.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  beforeEach(() => {
    vi.stubGlobal('visualViewport', undefined);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    app.unmount();
    root.remove();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('explains why an owner cannot turn 2FA off under required_for_admins', async () => {
    await mount({ twoFactorEnabled: true, mfaPolicy: 'required_for_admins', role: 'owner' });
    expect(byTestId('mfa-status')?.textContent).toContain('On');
    expect(byTestId('mfa-policy-note')?.textContent).toContain('your role is owner');
    expect(byTestId('disable-mfa')?.hasAttribute('disabled')).toBe(true);
    expect(byTestId('regenerate-codes')?.hasAttribute('disabled')).toBe(false);
  });

  it('lets a member turn 2FA off under required_for_admins', async () => {
    await mount({ twoFactorEnabled: true, mfaPolicy: 'required_for_admins', role: 'member' });
    expect(byTestId('mfa-policy-note')).toBeNull();
    expect(byTestId('disable-mfa')?.hasAttribute('disabled')).toBe(false);
  });

  it('offers to turn 2FA on when it is off', async () => {
    await mount({ twoFactorEnabled: false, mfaPolicy: 'optional' });
    expect(byTestId('mfa-status')?.textContent).toContain('Off');
    expect(byTestId('enable-mfa')).not.toBeNull();
    expect(byTestId('disable-mfa')).toBeNull();
  });
});
