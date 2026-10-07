import { describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, reactive } from 'vue';
import { createVuetify } from 'vuetify';
import { emptyForm, settingsPayload } from '../src/agents/form';
import AgentFormFields from '../src/components/agents/AgentFormFields.vue';

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);
vi.stubGlobal('visualViewport', Object.assign(new EventTarget(), { width: 1024, height: 768 }));

describe('agent limit fields', () => {
  it('edits the idle-run limit and explains that only runs without progress count', async () => {
    const form = reactive(emptyForm());
    expect(form.limits.maxIdleRunsPerIssue).toBe(2);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp({
      render: () => h(AgentFormFields, { modelValue: form, agents: [], models: [] }),
    });
    app.use(createVuetify()).mount(host);
    await nextTick();

    const field = host.querySelector('[data-test="idle-runs-field"]');
    expect(field?.textContent).toContain('Idle runs before backoff');
    expect(field?.textContent).toContain('without progress');
    expect(host.textContent).not.toMatch(/per hour/i);
    const input = field?.querySelector('input');
    if (!input) throw new Error('expected the idle-run input');
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    await nextTick();
    expect(settingsPayload(form).limits.maxIdleRunsPerIssue).toBe(5);
    app.unmount();
    host.remove();
  });
});
