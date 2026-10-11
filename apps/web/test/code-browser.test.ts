import { createPinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, ref, type App } from 'vue';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { createVuetify } from 'vuetify';
import type { TreeEntry } from '@conclavix/core';
import { archiveUrl, codeApi, downloadUrl } from '../src/code/api';
import {
  ancestorsOf,
  entryType,
  fileKind,
  folderRows,
  previewOf,
  sideBySide,
} from '../src/code/browse';
import { parsePatch } from '../src/code/logic';
import ProjectCodeTab from '../src/components/code/ProjectCodeTab.vue';
import { SHA_A, SHA_B, file, respond } from './code-fixtures';

const downloads = vi.hoisted(() => [] as { url: string; name: string }[]);
vi.mock('../src/code/download', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/code/download')>()),
  downloadFile: vi.fn(async (url: string, name: string) => {
    downloads.push({ url, name });
  }),
}));

describe('file browser logic', () => {
  it('classifies files and labels entries', () => {
    expect(fileKind('a/b.PNG')).toBe('image');
    expect(fileKind('clip.webm')).toBe('video');
    expect(fileKind('doc.pdf')).toBe('pdf');
    expect(fileKind('README.md')).toBe('markdown');
    expect(fileKind('bundle.zip')).toBe('archive');
    expect(fileKind('src/a.ts')).toBe('code');
    expect(fileKind('LICENSE')).toBe('file');
    const entry = (type: TreeEntry['type'], path: string) => ({ type, path });
    expect(entryType(entry('tree', 'src'))).toBe('Folder');
    expect(entryType(entry('blob', 'a.tar.gz'))).toBe('GZ');
    expect(entryType(entry('blob', 'Makefile'))).toBe('File');
  });

  it('picks the preview of a file', () => {
    expect(previewOf(file('a.png', { binary: true, content: null }))).toBe('image');
    expect(previewOf(file('a.png', { size: 11 * 1024 * 1024 }))).toBe('mediaTooLarge');
    expect(previewOf(file('a.mp4', { binary: true, content: null }))).toBe('video');
    expect(previewOf(file('a.pdf', { binary: true, content: null }))).toBe('pdf');
    expect(previewOf(file('a.zip', { binary: true, content: null }))).toBe('binary');
    expect(previewOf(file('a.log', { tooLarge: true, content: null }))).toBe('tooLarge');
    expect(previewOf(file('README.md'))).toBe('markdown');
    expect(previewOf(file('a.ts'))).toBe('text');
  });

  it('pairs deletions with the additions that follow for side by side', () => {
    const rows = sideBySide(parsePatch('@@ -1,3 +1,3 @@\n keep\n-a\n-b\n+c\n x'));
    expect(rows.map((row) => [row.kind, row.left?.text ?? null, row.right?.text ?? null])).toEqual([
      ['hunk', null, null],
      ['pair', 'keep', 'keep'],
      ['pair', 'a', 'c'],
      ['pair', 'b', null],
      ['pair', 'x', 'x'],
    ]);
  });

  it('lists the open folders of the tree depth first', () => {
    const children = new Map([
      ['', ['docs', 'src']],
      ['src', ['src/lib']],
      ['src/lib', []],
    ]);
    const rows = folderRows(children, new Set(['src']));
    expect(rows.map((row) => [row.path, row.depth, row.expandable])).toEqual([
      ['docs', 0, true],
      ['src', 0, true],
      ['src/lib', 1, false],
    ]);
    expect(ancestorsOf('a/b/c')).toEqual(['a', 'a/b', 'a/b/c']);
  });

  it('builds download, folder archive and diff URLs', async () => {
    expect(downloadUrl('p1', SHA_B, 'docs/a b.zip')).toBe(
      `/api/projects/p1/raw?ref=${SHA_B}&path=docs%2Fa%20b.zip&download=1`,
    );
    expect(archiveUrl('p1', 'main', 'src/lib')).toBe(
      '/api/projects/p1/archive?ref=main&path=src%2Flib',
    );
    expect(archiveUrl('p1', 'main', '')).toBe('/api/projects/p1/archive?ref=main');
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(url);
        return new Response('{}', { status: 200 });
      }),
    );
    await codeApi.diff('p1', { commit: 'abc1234' }, 'a.ts');
    await codeApi.diff('p1', { from: 'main', to: 'cvx/X-1', mode: 'direct' });
    expect(seen).toEqual([
      '/api/projects/p1/diff?commit=abc1234&path=a.ts',
      '/api/projects/p1/diff?from=main&to=cvx%2FX-1&mode=direct',
    ]);
    vi.unstubAllGlobals();
  });

  it('reads the file name of a download response', async () => {
    const { dispositionName } =
      await vi.importActual<typeof import('../src/code/download')>('../src/code/download');
    expect(dispositionName(`attachment; filename="_b.txt"; filename*=UTF-8''%C3%9Cb.txt`)).toBe(
      'Üb.txt',
    );
    expect(dispositionName('attachment; filename="a.zip"')).toBe('a.zip');
    expect(dispositionName(null)).toBeNull();
  });
});

describe('file browser in the Code tab', () => {
  let app: App | undefined;
  let host: HTMLElement;
  let router: Router;
  const requests: string[] = [];

  const flush = async () => {
    for (let i = 0; i < 8; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await nextTick();
    }
  };
  const click = async (selector: string) => {
    const element = host.querySelector<HTMLElement>(selector);
    expect(element, selector).not.toBeNull();
    element?.click();
    await flush();
  };

  beforeEach(() => {
    requests.length = 0;
    downloads.length = 0;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    vi.stubGlobal('visualViewport', Object.assign(new EventTarget(), { width: 1400, height: 900 }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requests.push(url);
        const body = respond(url);
        return body === null
          ? new Response(JSON.stringify({ error: 'not_found', message: 'nope' }), { status: 404 })
          : new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    app?.unmount();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  const project = ref('p1');

  async function mount(path: string, width = 1400) {
    project.value = 'p1';
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/projects/:projectKey', component: { render: () => null } }],
    });
    app = createApp({
      render: () => h(ProjectCodeTab, { projectId: project.value, projectKey: 'CVX' }),
    });
    app.use(createPinia()).use(router).use(createVuetify());
    await router.push(path);
    app.mount(host);
    await flush();
  }

  it('lists folders and files with their type and a folder tree', async () => {
    await mount('/projects/CVX?branch=cvx/CVX-1');
    const list = host.querySelector('[data-test="code-tree"]')?.textContent ?? '';
    expect(list).toContain('src');
    expect(list).toContain('data.zip');
    expect(list).toContain('2.0 KB');
    expect(host.querySelector('[data-test="folder-tree"]')?.textContent).toContain('src');
    expect(requests.filter((url) => url.includes('/tree'))).toHaveLength(1);
  });

  it('downloads a file and zips a folder at the commit of the listing', async () => {
    await mount('/projects/CVX?branch=cvx/CVX-1');
    await click('[data-test="row-download"]');
    await click('[data-test="row-zip"]');
    expect(downloads).toEqual([
      { url: downloadUrl('p1', SHA_B, 'data.zip'), name: 'data.zip' },
      { url: archiveUrl('p1', SHA_B, 'src'), name: 'CVX-src.zip' },
    ]);
  });

  it('offers a download instead of a preview for binary files', async () => {
    await mount('/projects/CVX?branch=cvx/CVX-1&file=data.zip');
    const viewer = host.querySelector('[data-test="file-no-preview"]');
    expect(viewer?.textContent).toContain('Binary file, no preview.');
    expect(host.textContent).not.toContain('Download the ZIP');
    await click('[data-test="file-download"]');
    expect(downloads).toEqual([{ url: downloadUrl('p1', SHA_B, 'data.zip'), name: 'data.zip' }]);
  });

  it('zips the open folder from the breadcrumb bar', async () => {
    await mount('/projects/CVX?branch=cvx/CVX-1&path=src');
    await click('[data-test="folder-zip"]');
    expect(downloads).toEqual([{ url: archiveUrl('p1', SHA_B, 'src'), name: 'CVX-src.zip' }]);
  });

  it('shows a commit diff with binary downloads and the full diff of a cut file', async () => {
    await mount(`/projects/CVX?branch=cvx/CVX-1&commit=${SHA_B}`);
    await click('[data-test="code-view-commits"]');
    expect(requests).toContain(`/api/projects/p1/commits/${SHA_B}`);
    await click('[data-test="diff-download-old"]');
    await click('[data-test="diff-download-new"]');
    expect(downloads).toEqual([
      { url: downloadUrl('p1', SHA_A, 'data.zip'), name: 'data.zip' },
      { url: downloadUrl('p1', SHA_B, 'data.zip'), name: 'data.zip' },
    ]);
    await click('[data-test="diff-full"]');
    expect(requests).toContain(`/api/projects/p1/diff?commit=${SHA_B}&path=long.txt`);
    expect(host.querySelector('[data-test="commit-detail"]')?.textContent).toContain('whole');
  });

  it('compares with main, directly on request, and side by side', async () => {
    await mount('/projects/CVX?branch=cvx/CVX-1');
    await click('[data-test="code-view-compare"]');
    expect(requests).toContain('/api/projects/p1/diff?from=main&to=cvx%2FCVX-1&mode=merge-base');
    expect(host.querySelector('[data-test="compare-summary"]')?.textContent).toContain(
      '2 commits ahead',
    );
    await click('[data-test="compare-direct"]');
    expect(requests).toContain('/api/projects/p1/diff?from=main&to=cvx%2FCVX-1&mode=direct');
    await click('[data-test="diff-layout-split"]');
    expect(host.querySelector('[data-test="diff-split"]')).not.toBeNull();
  });

  it('compares again when the project changes', async () => {
    await mount('/projects/CVX?branch=cvx/CVX-1');
    await click('[data-test="code-view-compare"]');
    project.value = 'p2';
    await flush();
    expect(requests).toContain('/api/projects/p2/diff?from=main&to=cvx%2FCVX-1&mode=merge-base');
  });
});
