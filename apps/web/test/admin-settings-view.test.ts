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
  let smtpResult: object;
  let smtpStatus: number;

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
    smtpStatus = 200;
    smtpResult = {
      ok: true,
      to: 'me@example.com',
      unsaved: false,
      messageId: '<id@test>',
      response: '250 2.0.0 Ok: queued as ABC',
    };
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
        if (url.endsWith('/smtp/test')) {
          return new Response(JSON.stringify(smtpResult), { status: smtpStatus });
        }
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

  const button = (text: string) =>
    [...root.querySelectorAll('button')].find((element) => element.textContent?.trim() === text);
  const type = async (label: string, value: string) => {
    const field = input(label);
    field.value = value;
    field.dispatchEvent(new Event('input'));
    await flush();
  };

  it('offers the SMTP test only to owners', async () => {
    await mount('admin');
    expect(button('Send test mail')).toBeUndefined();
  });

  it('sends a test mail with the saved settings to the owner by default', async () => {
    await mount('owner');
    expect(root.textContent).toContain('Uses the saved settings.');
    button('Send test mail')?.click();
    await flush();
    expect(requests.at(-1)).toEqual({ method: 'POST', url: '/api/settings/smtp/test', body: {} });
    const result = root.querySelector('[data-testid="smtp-test-result"]');
    expect(result?.textContent).toContain('Test mail sent to me@example.com');
    expect(result?.textContent).toContain('queued as ABC');
  });

  it('tests unsaved values and a typed recipient without saving, and shows failures', async () => {
    smtpResult = {
      ok: false,
      to: 'ops@example.com',
      unsaved: true,
      kind: 'auth',
      message: 'The SMTP server rejected the login (check user and password).',
      response: '535 5.7.8 Authentication failed',
    };
    await mount('owner');
    await type('Host', 'smtp.new');
    await type('Password', 'typed-pass');
    await type('Recipient', ' ops@example.com ');
    expect(root.textContent).toContain('Uses the unsaved values above without saving them.');
    button('Send test mail')?.click();
    await flush();
    expect(requests.at(-1)).toEqual({
      method: 'POST',
      url: '/api/settings/smtp/test',
      body: { to: 'ops@example.com', smtp: { host: 'smtp.new', pass: 'typed-pass' } },
    });
    expect(requests.some((request) => request.method === 'PATCH')).toBe(false);
    const result = root.querySelector('[data-testid="smtp-test-result"]');
    expect(result?.textContent).toContain('Login rejected');
    expect(result?.textContent).toContain('535 5.7.8 Authentication failed');
    expect(result?.textContent).toContain('Tried the unsaved values.');
  });

  it('shows an API error such as the rate limit', async () => {
    smtpStatus = 429;
    smtpResult = { error: 'rate_limited', message: 'Too many test mails; try again shortly' };
    await mount('owner');
    button('Send test mail')?.click();
    await flush();
    expect(root.querySelector('[data-testid="smtp-test-result"]')?.textContent).toContain(
      'Too many test mails',
    );
  });

  it('blocks the test while the host is missing', async () => {
    await mount('owner');
    await type('Host', '');
    expect(button('Send test mail')?.disabled).toBe(true);
  });
});
