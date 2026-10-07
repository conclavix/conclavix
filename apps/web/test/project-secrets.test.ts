import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createVuetify } from 'vuetify';
import ProjectSecretsTab from '../src/components/projects/ProjectSecretsTab.vue';
import type { Secret } from '../src/api/secrets';
import { secretPayload, suggestEnvName, valueRules, envNameRules } from '../src/secrets/form';

const secret: Secret = {
  id: 'a'.repeat(24),
  projectId: 'b'.repeat(24),
  name: 'Stripe test key',
  envName: 'STRIPE_TEST_KEY',
  agentIds: ['c'.repeat(24)],
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  lastUsedAt: null,
  lastUsedRunId: null,
};

describe('secret form helpers', () => {
  it('suggests an upper-case variable name from the display name', () => {
    expect(suggestEnvName('Stripe test key')).toBe('STRIPE_TEST_KEY');
    expect(suggestEnvName(' 2nd api-base ')).toBe('ND_API_BASE');
  });

  it('checks reserved names and value length like the API', () => {
    expect(envNameRules[0]?.('PATH')).toMatch(/reserved/);
    expect(envNameRules[0]?.('CLAUDE_CODE_X')).toMatch(/reserved/);
    expect(envNameRules[0]?.('STRIPE_TEST_KEY')).toBe(true);
    expect(valueRules(true)[0]?.('short')).toMatch(/at least 8/);
    expect(valueRules(false)[0]?.('')).toBe(true);
  });

  it('sends only changed fields when editing, never an empty value', () => {
    const draft = { name: secret.name, envName: secret.envName, value: '', agentIds: [] };
    expect(secretPayload(draft, secret)).toEqual({ agentIds: [] });
    expect(
      secretPayload({ ...draft, agentIds: secret.agentIds, value: 'new-value-123' }, secret),
    ).toEqual({
      value: 'new-value-123',
    });
  });
});

describe('project secrets tab', () => {
  let app: App | undefined;
  let host: HTMLDivElement | undefined;

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              items: [secret],
              agents: [{ id: 'c'.repeat(24), name: 'Coder', codeAccess: 'write' }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
  });

  afterEach(() => {
    app?.unmount();
    host?.remove();
    vi.unstubAllGlobals();
  });

  async function mount(isOwner: boolean): Promise<HTMLDivElement> {
    host = document.createElement('div');
    document.body.append(host);
    app = createApp(ProjectSecretsTab, { projectId: 'b'.repeat(24), isOwner });
    app.use(createVuetify());
    app.component('RouterLink', { props: ['to'], template: '<a><slot /></a>' });
    app.mount(host);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    return host;
  }

  it('lists metadata with the assigned agents and offers reveal to owners only', async () => {
    const owner = await mount(true);
    const row = owner.querySelector('[data-test="secret-STRIPE_TEST_KEY"]');
    expect(row?.textContent).toContain('Stripe test key');
    expect(row?.textContent).toContain('Coder');
    expect(row?.textContent).toContain('never');
    expect(owner.querySelector('[data-test="secret-reveal"]')).not.toBeNull();
    app?.unmount();
    host?.remove();

    const admin = await mount(false);
    expect(admin.querySelector('[data-test="secret-STRIPE_TEST_KEY"]')).not.toBeNull();
    expect(admin.querySelector('[data-test="secret-reveal"]')).toBeNull();
  });
});
