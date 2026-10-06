import { createPinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, type App } from 'vue';
import { createVuetify } from 'vuetify';
import MemoryPanel from '../src/components/memory/MemoryPanel.vue';

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);
vi.stubGlobal('visualViewport', Object.assign(new EventTarget(), { width: 1024, height: 768 }));

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
};

describe('agent knowledge panel', () => {
  let app: App | undefined;

  afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = '';
  });

  it.each([
    [false, 1],
    [true, 0],
  ])('read-only %s shows %i sets of write actions', async (readOnly, writable) => {
    const memory = {
      id: 'm1',
      scope: 'agent',
      projectId: null,
      agentId: 'a1',
      title: 'Deploy window',
      body: 'Weekdays only.',
      tags: [],
      author: { type: 'board' },
      revision: 1,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ items: [memory] }), { status: 200 })),
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    app = createApp({ render: () => h(MemoryPanel, { scope: 'agent', agentId: 'a1', readOnly }) });
    app.use(createPinia()).use(createVuetify());
    app.mount(host);
    for (let i = 0; i < 3; i++) await flush();
    host.querySelector<HTMLButtonElement>('.v-expansion-panel-title')?.click();
    for (let i = 0; i < 3; i++) await flush();
    expect(host.textContent).toContain('Weekdays only.');
    expect(host.querySelectorAll('[data-test="memory-new"]')).toHaveLength(writable);
    expect(host.querySelectorAll('[data-test="memory-edit"]')).toHaveLength(writable);
    expect(host.querySelectorAll('[data-test="memory-delete"]')).toHaveLength(writable);
  });
});
