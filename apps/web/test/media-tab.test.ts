import { createPinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, type App } from 'vue';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { createVuetify } from 'vuetify';
import type { MediaItem, MediaListing } from '@conclavix/core';
import ProjectMediaTab from '../src/components/media/ProjectMediaTab.vue';
import {
  branchFilterLabel,
  branchesOf,
  codeTabLink,
  hasThumbnail,
  issueKeys,
  mediaUrl,
  stepIndex,
} from '../src/media/logic';

const SHA = 'c'.repeat(40);

const item = (name: string, extra: Partial<MediaItem> = {}): MediaItem => ({
  oid: `${name}-oid`,
  path: `docs/screenshots/feedback/${name}`,
  name,
  kind: 'image',
  contentType: 'image/png',
  size: 2048,
  locations: [
    { branch: 'main', issueKey: null, path: `docs/screenshots/feedback/${name}` },
    { branch: 'cvx/CVX-1', issueKey: 'CVX-1', path: `docs/screenshots/feedback/${name}` },
  ],
  ref: SHA,
  commit: { sha: SHA, authorName: 'Agent', committedAt: '2026-10-05T10:00:00Z' },
  ...extra,
});

describe('media logic', () => {
  it('builds raw URLs by commit and Code tab links by branch', () => {
    const shot = item('list.png');
    expect(mediaUrl('p1', shot)).toBe(
      `/api/projects/p1/raw?ref=${SHA}&path=docs%2Fscreenshots%2Ffeedback%2Flist.png`,
    );
    expect(codeTabLink('CVX', shot)).toEqual({
      name: 'project',
      params: { projectKey: 'CVX' },
      query: {
        tab: 'code',
        branch: 'main',
        path: 'docs/screenshots/feedback',
        file: 'docs/screenshots/feedback/list.png',
      },
    });
    const root = item('a.png', {
      locations: [{ branch: 'cvx/X-2', issueKey: 'X-2', path: 'a.png' }],
    });
    expect(codeTabLink('CVX', root)).toEqual({
      name: 'project',
      params: { projectKey: 'CVX' },
      query: { tab: 'code', branch: 'cvx/X-2', file: 'a.png' },
    });
  });

  it('lists issues and branches once and shows thumbnails only for small images', () => {
    const shot = item('list.png', {
      locations: [
        { branch: 'cvx/CVX-1', issueKey: 'CVX-1', path: 'a.png' },
        { branch: 'cvx/CVX-1', issueKey: 'CVX-1', path: 'b.png' },
        { branch: 'cvx/CVX-2', issueKey: 'CVX-2', path: 'a.png' },
      ],
    });
    expect(issueKeys(shot)).toEqual(['CVX-1', 'CVX-2']);
    expect(branchesOf(shot)).toEqual(['cvx/CVX-1', 'cvx/CVX-2']);
    expect(hasThumbnail(shot)).toBe(true);
    expect(hasThumbnail(item('big.png', { size: 11 * 1024 * 1024 }))).toBe(false);
    expect(hasThumbnail(item('clip.mp4', { kind: 'video' }))).toBe(false);
    expect(branchFilterLabel({ name: 'cvx/CVX-1', issueKey: 'CVX-1' })).toBe('CVX-1 (cvx/CVX-1)');
    expect(branchFilterLabel({ name: 'main', issueKey: null })).toBe('main');
    expect(stepIndex(0, -1, 3)).toBeNull();
    expect(stepIndex(1, 1, 3)).toBe(2);
    expect(stepIndex(2, 1, 3)).toBeNull();
  });
});

describe('ProjectMediaTab', () => {
  let app: App | undefined;
  let host: HTMLElement;
  let router: Router;
  const requests: string[] = [];
  let pages: Record<string, MediaListing>;

  const listing = (items: MediaItem[], extra: Partial<MediaListing> = {}): MediaListing => ({
    items,
    total: items.length,
    nextOffset: null,
    truncated: false,
    scannedBranches: 2,
    facets: {
      kinds: { image: 2, video: 1, pdf: 0 },
      branches: [
        { name: 'main', issueKey: null, count: 3 },
        { name: 'cvx/CVX-1', issueKey: 'CVX-1', count: 3 },
      ],
    },
    ...extra,
  });

  const flush = async () => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await nextTick();
    }
  };

  beforeEach(() => {
    requests.length = 0;
    pages = {
      first: listing([item('one.png'), item('two.png')], { total: 3, nextOffset: 2 }),
      second: listing([item('clip.mp4', { kind: 'video', contentType: 'video/mp4' })], {
        total: 3,
      }),
    };
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    vi.stubGlobal('visualViewport', Object.assign(new EventTarget(), { width: 1024, height: 768 }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requests.push(url);
        let body: MediaListing;
        if (url.includes('q=none')) body = listing([]);
        else if (url.includes('offset=2')) body = pages['second'] ?? listing([]);
        else body = pages['first'] ?? listing([]);
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    app?.unmount();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  async function mount() {
    router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/projects/:projectKey', name: 'project', component: { render: () => null } },
        { path: '/issues/:issueKey', name: 'issue', component: { render: () => null } },
      ],
    });
    app = createApp({ render: () => h(ProjectMediaTab, { projectId: 'p1', projectKey: 'CVX' }) });
    app.use(createPinia()).use(router).use(createVuetify());
    await router.push('/projects/CVX?tab=media');
    app.mount(host);
    await flush();
  }

  it('shows a lazy thumbnail grid and loads more pages', async () => {
    await mount();
    expect(requests[0]).toBe('/api/projects/p1/media?sort=newest&offset=0&limit=60');
    const thumbs = host.querySelectorAll<HTMLImageElement>('[data-test="media-thumb"]');
    expect(thumbs).toHaveLength(2);
    expect(thumbs[0]?.getAttribute('loading')).toBe('lazy');
    expect(thumbs[0]?.getAttribute('src')).toContain(`ref=${SHA}`);
    expect(host.querySelector('[data-test="media-count"]')?.textContent).toContain('3 files');
    host.querySelector<HTMLElement>('[data-test="media-more"]')?.click();
    await flush();
    expect(requests.at(-1)).toBe('/api/projects/p1/media?sort=newest&offset=2&limit=60');
    expect(host.querySelectorAll('[data-test^="media-item-"]')).toHaveLength(3);
    expect(host.querySelector('[data-test="media-more"]')).toBeNull();
  });

  it('searches by path after a pause and explains an empty filter result', async () => {
    await mount();
    const input = host.querySelector('[data-test="media-search"] input') as HTMLInputElement;
    input.value = 'none';
    input.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 350));
    await flush();
    expect(requests.at(-1)).toBe('/api/projects/p1/media?q=none&sort=newest&offset=0&limit=60');
    expect(host.querySelector('[data-test="media-empty"]')?.textContent).toContain(
      'No media matches these filters',
    );
  });

  it('explains where media comes from when the project has none', async () => {
    pages['first'] = listing([]);
    await mount();
    const empty = host.querySelector('[data-test="media-empty"]')?.textContent ?? '';
    expect(empty).toContain('No media in this project yet');
    expect(empty).toContain('docs/screenshots/<module>/');
  });

  it('warns when the scan was truncated', async () => {
    pages['first'] = listing([item('one.png')], { truncated: true });
    await mount();
    expect(host.querySelector('[data-test="media-truncated"]')).not.toBeNull();
  });

  const inBox = (test: string): HTMLElement | null =>
    document.querySelector(`[data-test="media-lightbox"] [data-test="${test}"]`);
  const textOf = (test: string): string => (inBox(test)?.textContent ?? '').trim();
  const attrOf = (test: string, name: string): string => inBox(test)?.getAttribute(name) ?? '';

  it('opens a lightbox with download, Code tab and issue links', async () => {
    await mount();
    host.querySelector<HTMLElement>('[data-test="media-item-0"]')?.click();
    await flush();
    expect(textOf('lightbox-name')).toBe('one.png');
    expect(textOf('lightbox-position')).toBe('1 / 3');
    expect(attrOf('lightbox-download', 'href')).toContain(`ref=${SHA}`);
    expect(attrOf('lightbox-download', 'download')).toBe('one.png');
    expect(attrOf('lightbox-code', 'href')).toBe(
      '/projects/CVX?tab=code&branch=main&file=docs/screenshots/feedback/one.png&path=docs/screenshots/feedback',
    );
    expect(attrOf('lightbox-issue', 'href')).toBe('/issues/CVX-1');
    expect(inBox('lightbox-prev')).toBeNull();
    inBox('lightbox-close')?.click();
    await flush();
    expect(document.querySelector('[data-test="media-lightbox"]')).toBeNull();
  });

  it('zooms and steps through the items, loading the next page at the end', async () => {
    await mount();
    host.querySelector<HTMLElement>('[data-test="media-item-0"]')?.click();
    await flush();
    inBox('zoom-reset')?.click();
    await flush();
    expect(textOf('zoom-reset')).toContain('100%');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    await flush();
    expect(textOf('lightbox-name')).toBe('two.png');
    expect(textOf('zoom-reset')).toContain('Fit');

    inBox('lightbox-next')?.click();
    await flush();
    expect(requests.at(-1)).toContain('offset=2');
    expect(textOf('lightbox-name')).toBe('clip.mp4');
    expect(inBox('lightbox-video')).not.toBeNull();
    expect(inBox('lightbox-next')).toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    await flush();
    expect(textOf('lightbox-name')).toBe('two.png');
  });
});
