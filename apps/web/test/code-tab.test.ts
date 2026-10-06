import { createPinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, type App } from 'vue';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { createVuetify } from 'vuetify';
import type { BranchInfo, FileDiff } from '@conclavix/core';
import { archiveUrl, query, rawUrl } from '../src/code/api';
import { highlight, languageOf, splitHighlightedLines } from '../src/code/highlight';
import {
  archiveName,
  branchLabel,
  breadcrumbs,
  diffStats,
  fileTitle,
  formatBytes,
  initiallyOpen,
  isImagePath,
  emptyState,
  parentPath,
  parsePatch,
  pickBranch,
} from '../src/code/logic';
import ProjectCodeTab from '../src/components/code/ProjectCodeTab.vue';

const branch = (name: string, ahead = 0, behind = 0): BranchInfo => ({
  name,
  sha: 'a'.repeat(40),
  ahead,
  behind,
  isDefault: name === 'main',
  issueKey: name.startsWith('cvx/') ? name.slice(4) : null,
  lastCommit: {
    sha: 'a'.repeat(40),
    shortSha: 'aaaaaaa',
    subject: 'Initialize repository',
    authorName: 'Conclavix',
    committedAt: '2026-10-05T10:00:00Z',
  },
});

const fileDiff = (path: string, extra: Partial<FileDiff> = {}): FileDiff => ({
  path,
  oldPath: null,
  status: 'modified',
  binary: false,
  additions: 1,
  deletions: 1,
  patch: '@@ -1 +1 @@\n-a\n+b',
  truncated: false,
  ...extra,
});

describe('code tab logic', () => {
  it('numbers the lines of a unified diff', () => {
    const lines = parsePatch(
      '@@ -3,3 +3,4 @@ fn\n keep\n-old\n+new\n+more\n\\ No newline at end of file',
    );
    expect(lines.map((l) => [l.kind, l.oldLine, l.newLine, l.text])).toEqual([
      ['hunk', null, null, '@@ -3,3 +3,4 @@ fn'],
      ['context', 3, 3, 'keep'],
      ['del', 4, null, 'old'],
      ['add', null, 4, 'new'],
      ['add', null, 5, 'more'],
      ['note', null, null, '\\ No newline at end of file'],
    ]);
    expect(parsePatch(null)).toEqual([]);
  });

  it('summarises diffs and opens small ones', () => {
    const files = [fileDiff('a'), fileDiff('b', { additions: 3, deletions: 0 })];
    expect(diffStats(files)).toEqual({ files: 2, additions: 4, deletions: 1 });
    expect(initiallyOpen(files)).toEqual(['a', 'b']);
    expect(initiallyOpen(Array.from({ length: 11 }, (_, i) => fileDiff(`f${i}`)))).toEqual([]);
    expect(fileTitle(fileDiff('new.ts', { oldPath: 'old.ts', status: 'renamed' }))).toBe(
      'old.ts → new.ts',
    );
  });

  it('builds breadcrumbs and parent paths', () => {
    expect(breadcrumbs('src/lib/a.ts').map((c) => c.path)).toEqual([
      '',
      'src',
      'src/lib',
      'src/lib/a.ts',
    ]);
    expect(parentPath('src/lib/a.ts')).toBe('src/lib');
    expect(parentPath('a.ts')).toBe('');
  });

  it('picks the requested branch, else main', () => {
    const branches = [branch('main'), branch('cvx/CVX-1', 2, 1)];
    expect(pickBranch(branches, 'cvx/CVX-1')).toBe('cvx/CVX-1');
    expect(pickBranch(branches, 'gone')).toBe('main');
    expect(pickBranch([], undefined)).toBe('main');
    expect(branchLabel(branch('cvx/CVX-1', 2, 1))).toBe('cvx/CVX-1 (+2 / -1)');
    expect(branchLabel(branch('main'))).toBe('main');
  });

  it('picks the empty-state hint', () => {
    expect(emptyState([branch('main')], '', 0)).toBe('repository');
    expect(emptyState([branch('main'), branch('cvx/CVX-1')], '', 0)).toBe('branch');
    expect(emptyState([branch('main')], '', 1)).toBeNull();
    expect(emptyState([branch('main')], 'src', 0)).toBeNull();
    expect(emptyState([branch('main')], '', null)).toBeNull();
  });

  it('formats sizes, archive names and URLs', () => {
    expect(formatBytes(12)).toBe('12 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(null)).toBe('');
    expect(archiveName('CVX', 'cvx/CVX-1', 'b'.repeat(40))).toBe(
      `CVX-cvx-CVX-1-${'b'.repeat(12)}.zip`,
    );
    expect(query({ ref: 'cvx/A-1', path: 'a b', skip: 0, x: undefined })).toBe(
      '?ref=cvx%2FA-1&path=a%20b&skip=0',
    );
    expect(archiveUrl('p1', 'main')).toBe('/api/projects/p1/archive?ref=main');
  });

  it('highlights known languages and escapes everything else', () => {
    expect(languageOf('src/a.ts')).toBe('typescript');
    expect(languageOf('Dockerfile')).toBe('dockerfile');
    expect(languageOf('notes')).toBeNull();
    expect(highlight('<img src=x onerror=alert(1)>', 'a.txt')).toBe(
      '&lt;img src=x onerror=alert(1)&gt;',
    );
    const html = highlight('const a = "<b>";', 'a.ts');
    expect(html).toContain('hljs-keyword');
    expect(html).not.toContain('<b>');
    expect(highlight('<script>alert(1)</script>', 'a.html')).not.toContain('<script');
  });

  it('keeps spans balanced when splitting highlighted lines', () => {
    const lines = splitHighlightedLines('<span class="c">/* a\nb */</span>\nx\n');
    expect(lines).toEqual(['<span class="c">/* a</span>', '<span class="c">b */</span>', 'x']);
  });
});

describe('raw images', () => {
  it('recognises the image types the API serves raw', () => {
    for (const path of ['a.png', 'docs/x.JPG', 'b.jpeg', 'c.gif', 'd.webp', 'e.svg', '.x.png']) {
      expect(isImagePath(path), path).toBe(true);
    }
    for (const path of ['a.txt', 'png', '.png', 'docs/.svg', 'a.png.txt', 'a.bmp']) {
      expect(isImagePath(path), path).toBe(false);
    }
  });

  it('builds the raw URL with every value encoded', () => {
    expect(rawUrl('p1', 'cvx/CVX-1', 'docs/a b.png')).toBe(
      '/api/projects/p1/raw?ref=cvx%2FCVX-1&path=docs%2Fa%20b.png',
    );
  });
});

describe('ProjectCodeTab', () => {
  let app: App | undefined;
  let host: HTMLElement;
  let router: Router;
  const requests: string[] = [];
  let branchList: BranchInfo[] = [];

  const flush = async () => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await nextTick();
    }
  };

  function respond(url: string): unknown {
    if (url.includes('/branches')) return { items: branchList };
    if (url.includes('/tree')) {
      if (url.includes('ref=main')) return { ref: 'main', sha: 'a', path: '', entries: [] };
      return {
        ref: 'cvx/CVX-1',
        sha: 'b',
        path: '',
        entries: [{ name: 'README.md', path: 'README.md', type: 'blob', mode: '100644', size: 7 }],
      };
    }
    if (url.includes('/file') && url.includes('.png')) {
      const huge = url.includes('huge');
      return {
        ref: 'cvx/CVX-1',
        sha: 'b'.repeat(40),
        path: huge ? 'docs/huge.png' : 'docs/shot.png',
        size: huge ? 11 * 1024 * 1024 : 2048,
        binary: true,
        tooLarge: huge,
        content: null,
      };
    }
    if (url.includes('/file')) {
      return {
        ref: 'cvx/CVX-1',
        sha: 'b',
        path: 'README.md',
        size: 7,
        binary: false,
        tooLarge: false,
        content: '# Demo\n',
      };
    }
    if (url.includes('/compare')) {
      return {
        base: 'main',
        head: 'cvx/CVX-1',
        baseSha: 'a',
        headSha: 'b',
        mergeBase: 'a',
        ahead: 1,
        behind: 0,
        commits: [],
        diff: { files: [fileDiff('README.md', { status: 'added' })], truncated: false },
      };
    }
    return { items: [], nextSkip: null };
  }

  beforeEach(() => {
    requests.length = 0;
    branchList = [branch('main'), branch('cvx/CVX-1', 1, 0)];
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

  async function mount(path: string) {
    router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/projects/:projectKey', component: { render: () => null } }],
    });
    app = createApp({ render: () => h(ProjectCodeTab, { projectId: 'p1', projectKey: 'CVX' }) });
    app.use(createPinia()).use(router).use(createVuetify());
    await router.push(path);
    app.mount(host);
    await flush();
  }

  it('explains the empty repository', async () => {
    branchList = [branch('main')];
    await mount('/projects/CVX');
    expect(host.querySelector('[data-test="code-empty"]')?.textContent).toContain(
      'Agents will write their code here',
    );
  });

  it('points to the issue branches while main is empty', async () => {
    await mount('/projects/CVX');
    expect(host.querySelector('[data-test="code-empty"]')?.textContent).toContain('pick one above');
  });

  it('opens a file of the branch from the query and shows its content', async () => {
    await mount('/projects/CVX?branch=cvx/CVX-1&file=README.md');
    expect(requests).toContain('/api/projects/p1/file?ref=cvx%2FCVX-1&path=README.md');
    expect(requests.filter((url) => url.includes('/tree'))).toEqual([
      '/api/projects/p1/tree?ref=cvx%2FCVX-1&path=',
    ]);
    expect(host.querySelector('[data-test="file-path"]')?.textContent).toBe('README.md');
    expect(host.querySelector('[data-test="file-viewer"]')?.textContent).toContain('# Demo');
    expect(host.querySelector('[data-test="code-empty"]')).toBeNull();
  });

  it('shows an image inline, addressed by commit, linking to the full size', async () => {
    await mount('/projects/CVX?branch=cvx/CVX-1&file=docs/shot.png');
    const image = host.querySelector<HTMLImageElement>('[data-test="file-image"]');
    const url = `/api/projects/p1/raw?ref=${'b'.repeat(40)}&path=docs%2Fshot.png`;
    expect(image?.getAttribute('src')).toBe(url);
    expect(image?.closest('a')?.getAttribute('href')).toBe(url);
    expect(image?.closest('a')?.getAttribute('target')).toBe('_blank');
    expect(host.textContent).not.toContain('Binary file');
  });

  it('does not load images above the raw limit', async () => {
    await mount('/projects/CVX?branch=cvx/CVX-1&file=docs/huge.png');
    expect(host.querySelector('[data-test="file-image"]')).toBeNull();
    expect(host.querySelector('[data-test="file-viewer"]')?.textContent).toContain(
      'larger than 10 MB',
    );
  });

  it('keeps the newest selection when an older response arrives late', async () => {
    let releaseSlow: (() => void) | undefined;
    const fetchMock = vi.mocked(fetch);
    const fast = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('path=slow')) {
        await new Promise<void>((resolve) => (releaseSlow = resolve));
        return new Response(
          JSON.stringify({ ref: 'cvx/CVX-1', sha: 'b', path: 'slow', entries: [] }),
          { status: 200 },
        );
      }
      return fast ? fast(input, init) : new Response('{}', { status: 500 });
    });
    await mount('/projects/CVX?branch=cvx/CVX-1');
    await router.replace('/projects/CVX?branch=cvx/CVX-1&path=slow');
    await flush();
    await router.replace('/projects/CVX?branch=cvx/CVX-1');
    await flush();
    releaseSlow?.();
    await flush();
    expect(host.querySelector('[data-test="code-tree"]')?.textContent).toContain('README.md');
  });

  it('drops the error of a request the user has moved on from', async () => {
    let failSlow: (() => void) | undefined;
    const fetchMock = vi.mocked(fetch);
    const fast = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('path=slow')) {
        await new Promise<void>((resolve) => (failSlow = resolve));
        return new Response(JSON.stringify({ error: 'internal', message: 'boom' }), {
          status: 500,
        });
      }
      return fast ? fast(input, init) : new Response('{}', { status: 500 });
    });
    await mount('/projects/CVX?branch=cvx/CVX-1');
    await router.replace('/projects/CVX?branch=cvx/CVX-1&path=slow');
    await flush();
    await router.replace('/projects/CVX?branch=cvx/CVX-1');
    await flush();
    failSlow?.();
    await flush();
    expect(host.textContent).not.toContain('boom');
  });

  it('compares a branch with main', async () => {
    await mount('/projects/CVX?branch=cvx/CVX-1');
    host.querySelector<HTMLElement>('[data-test="code-view-compare"]')?.click();
    await flush();
    expect(requests).toContain('/api/projects/p1/compare?branch=cvx%2FCVX-1');
    expect(host.querySelector('[data-test="compare-view"]')?.textContent).toContain(
      '1 commits ahead',
    );
    expect(host.querySelectorAll('[data-test="diff-file"]')).toHaveLength(1);
  });
});
