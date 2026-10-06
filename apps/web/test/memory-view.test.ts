import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, reactive } from 'vue';
import { createVuetify } from 'vuetify';
import MemoryView from '../src/views/MemoryView.vue';
import { tokenStore } from '../src/api/client';

const route = reactive({ query: { level: 'project', project: 'p1', agent: 'a1' } });
vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => ({ replace: vi.fn() }) }));
const panels = vi.hoisted(() => ({ mounted: 0, unmounted: 0 }));
vi.mock('../src/components/memory/MemoryPanel.vue', async () => {
  const { onUnmounted } = await import('vue');
  return {
    default: defineComponent({
      setup() {
        panels.mounted++;
        onUnmounted(() => panels.unmounted++);
        return () => h('div', { 'data-test': 'panel-stub' });
      },
    }),
  };
});

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
};

describe('memory view', () => {
  let app: ReturnType<typeof createApp>;
  let host: HTMLDivElement;
  const fetchMock = vi.fn();
  beforeEach(() => {
    route.query = { level: 'project', project: 'p1', agent: 'a1' };
    panels.mounted = panels.unmounted = 0;
    tokenStore.set('t'.repeat(32));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    host = document.createElement('div');
    document.body.append(host);
  });
  afterEach(() => {
    app?.unmount();
    host.remove();
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });
  function mount() {
    app = createApp(MemoryView);
    app.use(createVuetify());
    app.mount(host);
  }

  it.each(['project', 'agent'])(
    'keeps the %s picker usable when the other request fails',
    async (healthy) => {
      route.query.level = healthy;
      fetchMock.mockImplementation(async (url: string) => {
        if (url === `/api/${healthy}s`) {
          return new Response(
            JSON.stringify({
              items:
                healthy === 'project'
                  ? [{ id: 'p1', key: 'PROJ', name: 'Healthy project' }]
                  : [{ id: 'a1', name: 'Healthy agent', title: 'Engineer' }],
            }),
          );
        }
        return new Response(JSON.stringify({ message: 'Other picker unavailable' }), {
          status: 500,
        });
      });
      mount();
      await flush();
      expect(host.textContent).toContain('Other picker unavailable');
      expect(host.textContent).toContain(
        healthy === 'project' ? 'PROJ Healthy project' : 'Healthy agent (Engineer)',
      );
    },
  );

  it('replaces the panel and its dialogs on owner and scope changes', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ items: [] })));
    mount();
    await flush();
    expect(panels.mounted).toBe(1);
    route.query.project = 'p2';
    await nextTick();
    expect(panels.unmounted).toBe(1);
    expect(panels.mounted).toBe(2);
    route.query.level = 'agent';
    await nextTick();
    expect(panels.unmounted).toBe(2);
    expect(panels.mounted).toBe(3);
  });
});
