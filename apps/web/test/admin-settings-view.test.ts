import { createPinia, setActivePinia } from 'pinia';
import { createApp, nextTick, type App } from 'vue';
import { createVuetify } from 'vuetify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../src/stores/auth';

vi.mock('vue-router', () => ({ onBeforeRouteLeave: vi.fn() }));
const { default: AdminSettingsView } = await import('../src/views/admin/AdminSettingsView.vue');

const settings = () => ({
  values: {
    instanceName: 'Conclavix',
    mfaPolicy: 'optional',
    models: ['opus'],
    smtp: { host: 'smtp.env', port: 587, secure: false, user: 'u', from: 'a@b.c', passSet: true },
  },
  sources: { instanceName: 'db', mfaPolicy: 'env', models: 'env', smtp: 'env' },
  readOnly: { sessionTtlHours: 168, boardUrl: 'http://board.test' },
  ownerOnly: ['mfaPolicy', 'smtp'],
});

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

describe('settings view gating', () => {
  let app: App;
  let root: HTMLDivElement;
  let requests: { method: string; url: string; body: unknown }[];

  async function mount(role: string) {
    const pinia = createPinia();
    setActivePinia(pinia);
    useAuthStore().me = { kind: 'user', id: 'me', role, mfaRequired: false };
    root = document.createElement('div');
    document.body.append(root);
    app = createApp(AdminSettingsView).use(pinia).use(createVuetify());
    app.mount(root);
    await flush();
    await flush();
  }

  beforeEach(() => {
    requests = [];
    vi.stubGlobal('visualViewport', undefined);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? 'GET';
        requests.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : null });
        return new Response(JSON.stringify(settings()), { status: 200 });
      }),
    );
  });

  afterEach(() => {
    app.unmount();
    root.remove();
    vi.unstubAllGlobals();
  });

  const input = (label: string): HTMLInputElement => {
    const field = [...root.querySelectorAll('.v-input')].find((element) =>
      element.querySelector('label')?.textContent?.includes(label),
    );
    const found = field?.querySelector('input');
    if (!found) throw new Error(`no input ${label}`);
    return found;
  };

  it('disables owner-only sections for an admin and explains why', async () => {
    await mount('admin');
    expect(input('Instance name').disabled).toBe(false);
    expect(input('Host').disabled).toBe(true);
    expect(input('Password').disabled).toBe(true);
    expect(root.textContent).toContain('Only an owner can change the MFA policy');
    expect(root.textContent).toContain('Only an owner can change SMTP');
    expect(root.textContent).toContain('Session lifetime (hours)');
  });

  it('lets an owner edit SMTP and saves only the changed group', async () => {
    await mount('owner');
    expect(input('Host').disabled).toBe(false);
    const name = input('Instance name');
    name.value = 'Renamed';
    name.dispatchEvent(new Event('input'));
    await flush();
    const save = [...root.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Save' && !button.disabled,
    );
    save?.click();
    await flush();
    expect(requests.at(-1)).toEqual({
      method: 'PATCH',
      url: '/api/settings',
      body: { instanceName: 'Renamed' },
    });
  });
});
