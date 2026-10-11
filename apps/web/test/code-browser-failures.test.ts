import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, reactive, type App } from 'vue';
import { createVuetify } from 'vuetify';
import { downloadFile } from '../src/code/download';
import CodeDiffFile from '../src/components/code/CodeDiffFile.vue';
import CodeFolderTree from '../src/components/code/CodeFolderTree.vue';
import { ENTRIES, SHA_A, SHA_B, diffFile, respond } from './code-fixtures';

describe('file browser failure handling', () => {
  let app: App | undefined;
  let host: HTMLElement;
  const flush = async () => {
    for (let i = 0; i < 8; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await nextTick();
    }
  };

  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    app?.unmount();
    app = undefined;
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('checks a session download with HEAD and reports a refusal', async () => {
    const calls: [string, string | undefined][] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push([url, init?.method]);
        return new Response(null, { status: 413 });
      }),
    );
    await expect(downloadFile('/api/x', 'x', { check: true })).rejects.toThrow(
      'larger than the download limit',
    );
    expect(calls).toEqual([['/api/x', 'HEAD']]);
  });

  it('keeps a failed folder expandable and loads it again on retry', async () => {
    let fail = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const path = new URL(url, 'http://x').searchParams.get('path') ?? '';
        if (path === '' && fail) {
          return new Response(JSON.stringify({ error: 'internal', message: 'boom' }), {
            status: 500,
          });
        }
        return new Response(
          JSON.stringify({ ref: 'x', sha: SHA_B, path, entries: path === '' ? ENTRIES : [] }),
          { status: 200 },
        );
      }),
    );
    const listing = { ref: 'x', sha: SHA_B, path: 'src', entries: [] };
    app = createApp({ render: () => h(CodeFolderTree, { projectId: 'p1', listing }) });
    app.use(createVuetify()).mount(host);
    await flush();
    expect(host.querySelector('[data-test="folder-root-failed"]')).not.toBeNull();
    fail = false;
    host.querySelector<HTMLElement>('[data-test="folder-root-failed"] button')?.click();
    await flush();
    expect(host.querySelector('[data-test="folder-root-failed"]')).toBeNull();
    expect(host.querySelector('[data-test="folder-tree"]')?.textContent).toContain('src');
  });

  it('drops a full file diff that answers after the comparison changed', async () => {
    let release: (() => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await new Promise<void>((resolve) => (release = resolve));
        return new Response(JSON.stringify(respond('/diff')), { status: 200 });
      }),
    );
    const props = reactive({
      file: diffFile('long.txt', { truncated: true }),
      split: false,
      projectId: 'p1',
      fromSha: SHA_A,
      toSha: SHA_B,
      request: { from: 'main', to: 'x', mode: 'merge-base' as const },
    });
    app = createApp({ render: () => h(CodeDiffFile, props) });
    app.use(createVuetify()).mount(host);
    await flush();
    host.querySelector<HTMLElement>('[data-test="diff-full"]')?.click();
    await flush();
    props.request = { from: 'main', to: 'x', mode: 'direct' as const };
    props.file = diffFile('long.txt', { truncated: true, patch: '@@ -1 +1 @@\n-direct\n+view' });
    await flush();
    release?.();
    await flush();
    expect(host.textContent).toContain('direct');
    expect(host.textContent).not.toContain('whole');
  });

  it('asks for the full diff of a renamed file with its old path', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify(respond('/diff')), { status: 200 });
      }),
    );
    const file = diffFile('new.txt', { oldPath: 'old.txt', status: 'renamed', truncated: true });
    app = createApp({
      render: () =>
        h(CodeDiffFile, {
          file,
          split: false,
          projectId: 'p1',
          fromSha: SHA_A,
          toSha: SHA_B,
          request: { commit: SHA_B },
        }),
    });
    app.use(createVuetify()).mount(host);
    await flush();
    host.querySelector<HTMLElement>('[data-test="diff-full"]')?.click();
    await flush();
    expect(urls).toEqual([`/api/projects/p1/diff?commit=${SHA_B}&path=new.txt&oldPath=old.txt`]);
  });
});
