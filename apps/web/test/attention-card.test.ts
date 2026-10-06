import { createPinia } from 'pinia';
import { createApp, nextTick, type App } from 'vue';
import { createVuetify } from 'vuetify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import AttentionCard from '../src/components/overview/AttentionCard.vue';

vi.mock('../src/api/client', () => ({ api: vi.fn() }));

let app: App | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  app?.unmount();
  host?.remove();
  vi.mocked(api).mockReset();
  vi.unstubAllGlobals();
});

describe('attention resume', () => {
  it.each(['success', 'failure'])(
    'serializes requests and unlocks buttons after %s',
    async (outcome) => {
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe() {}
          unobserve() {}
          disconnect() {}
        },
      );
      const request = Promise.withResolvers<Record<string, unknown>>();
      vi.mocked(api).mockReturnValueOnce(request.promise).mockResolvedValue({ status: 'active' });
      const changed = vi.fn();
      host = document.createElement('div');
      document.body.append(host);
      app = createApp(AttentionCard, {
        attention: {
          pausedAgents: ['alice', 'bob'].map((agentId) => ({
            agentId,
            name: agentId,
            reason: 'manual' as const,
            issueId: null,
            issueKey: null,
            since: '2026-10-04T00:00:00Z',
          })),
          budgetHeld: [],
          failedRuns: [],
          failedRuns24h: 0,
          blockedIssues: [],
          inReview: [],
        },
        now: Date.parse('2026-10-04T01:00:00Z'),
        onChanged: changed,
      });
      app.use(createPinia());
      app.use(createVuetify());
      app.component('RouterLink', { template: '<a><slot /></a>' });
      app.mount(host);
      const buttons = [...host.querySelectorAll('button')];
      expect(buttons).toHaveLength(2);

      const [firstButton, secondButton] = buttons;
      if (!firstButton || !secondButton) throw new Error('Expected two Resume buttons');
      firstButton.click();
      // A second click before Vue renders disabled buttons must also be guarded.
      secondButton.click();
      expect(api).toHaveBeenCalledTimes(1);
      await nextTick();
      expect(buttons.every((button) => button.disabled)).toBe(true);

      if (outcome === 'success') request.resolve({ status: 'active' });
      else request.reject(new Error('resume failed'));
      await request.promise.catch(() => {});
      await nextTick();
      expect([...host.querySelectorAll('button')].every((button) => !button.disabled)).toBe(true);
      expect(changed).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0);
      if (outcome === 'failure') expect(host.textContent).toContain('resume failed');

      secondButton.click();
      await Promise.resolve();
      await nextTick();
      expect(api).toHaveBeenCalledTimes(2);
      expect(api).toHaveBeenLastCalledWith(
        '/agents/bob',
        expect.objectContaining({ method: 'PATCH' }),
      );
    },
  );
});
