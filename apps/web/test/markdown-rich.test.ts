import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, type App } from 'vue';
import { createVuetify } from 'vuetify';
import MarkdownBlock from '../src/components/MarkdownBlock.vue';
import { imageSource, markdownToText, renderRichMarkdown } from '../src/markdown-rich';
import { issueRepoContext, provideRepoContext, type RepoContext } from '../src/repo-context';

const repo: RepoContext = { projectId: 'p1', ref: 'cvx/CVX-1' };
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

describe('markdown rendering', () => {
  it('renders Markdown but never raw HTML or script links', () => {
    const html = renderRichMarkdown(
      '**bold** <img src=x onerror=alert(1)> [x](javascript:alert(1)) https://example.com',
    );
    expect(html).toContain('<strong>bold</strong>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('escapes HTML inside code', () => {
    expect(renderRichMarkdown('```\n<img onerror=x>\n```')).toBe(
      '<pre><code>&lt;img onerror=x&gt;\n</code></pre>\n',
    );
  });

  it('keeps single line breaks only when asked', () => {
    expect(renderRichMarkdown('a\nb')).not.toContain('<br>');
    expect(renderRichMarkdown('a\nb', { breaks: true })).toContain('<br>');
  });
});

describe('markdown images', () => {
  it('resolves repo: paths against the given repository', () => {
    const html = renderRichMarkdown(
      '![list view](repo:docs/screenshots/feedback/list.png "The list")',
      { repo },
    );
    const img = parse(html).querySelector('img');
    expect(img?.getAttribute('src')).toBe(
      '/api/projects/p1/raw?ref=cvx%2FCVX-1&path=docs%2Fscreenshots%2Ffeedback%2Flist.png',
    );
    expect(img?.getAttribute('alt')).toBe('list view');
    expect(img?.getAttribute('title')).toBe('The list');
    expect(img?.getAttribute('loading')).toBe('lazy');
  });

  it('decodes repo: paths written with spaces or a leading slash', () => {
    expect(imageSource('repo:/docs/a%20b.png', repo)).toBe(
      '/api/projects/p1/raw?ref=cvx%2FCVX-1&path=docs%2Fa%20b.png',
    );
    const html = renderRichMarkdown('![x](<repo:docs/a b.png>)', { repo });
    expect(parse(html).querySelector('img')?.getAttribute('src')).toBe(
      '/api/projects/p1/raw?ref=cvx%2FCVX-1&path=docs%2Fa%20b.png',
    );
    expect(imageSource('repo:%E0%A4%A', repo)).toBeNull();
    expect(imageSource('repo:', repo)).toBeNull();
    expect(imageSource('/\\example.com/x.png', repo)).toBeNull();
  });

  it.each([
    ['![shot](https://example.com/shot.png)', 'https://example.com/shot.png'],
    ['![shot](/api/avatars/agent/a1)', '/api/avatars/agent/a1'],
    ['![shot][s]\n\n[s]: https://example.com/s.png', 'https://example.com/s.png'],
  ])('embeds %s', (source, src) => {
    const img = parse(renderRichMarkdown(source)).querySelector('img');
    expect(img?.getAttribute('src')).toBe(src);
  });

  it.each([
    '![shot](repo:docs/shot.png)',
    '![shot](http://example.com/pixel.png)',
    '![shot](//example.com/pixel.png)',
    '![shot](data:image/png;base64,iVBORw0KGgo=)',
    '![shot](javascript:alert(1))',
    '![shot](docs/relative.png)',
    '<img src="https://example.com/pixel.png" alt="shot">',
  ])('shows only the alt text for %s', (source) => {
    const document = parse(renderRichMarkdown(source));
    expect(document.querySelector('img, picture, source, video, audio, iframe')).toBeNull();
    expect(document.querySelector('[src], [srcset]')).toBeNull();
    expect(document.body.textContent).toContain('shot');
  });

  it.each([
    '/api/projects/p1/archive?ref=main',
    '/api/projects/p1/raw/../archive?ref=main',
    '/api/avatars/agent/../../projects/p1/archive',
    '/api/projects/p1/%2e%2e/p1/archive',
    '/api/avatars\\..\\..\\projects/p1/archive',
    '/logout',
    `${window.location.origin}/api/projects/p1/archive?ref=main`,
  ])('refuses same-origin image paths outside the raw and avatar routes: %s', (src) => {
    expect(imageSource(src, repo)).toBeNull();
    expect(parse(renderRichMarkdown(`![shot](<${src}>)`)).querySelector('img')).toBeNull();
  });

  it('keeps only the alt text of images in plain-text excerpts', () => {
    expect(markdownToText('Intro ![the list](https://example.com/x.png) end')).toBe(
      'Intro the list end',
    );
  });

  it('escapes the alt text of a refused image', () => {
    const html = renderRichMarkdown('![<b>x</b>](data:x)');
    expect(html).not.toContain('<b>');
  });
});

describe('repo context', () => {
  it("uses the issue's branch, else main", () => {
    expect(issueRepoContext({ projectId: 'p1', branch: 'cvx/CVX-1' })).toEqual(repo);
    expect(issueRepoContext({ projectId: 'p1', branch: null })).toEqual({
      projectId: 'p1',
      ref: 'main',
    });
    expect(issueRepoContext({ branch: 'x' })).toBeNull();
    expect(issueRepoContext(undefined)).toBeNull();
  });
});

describe('MarkdownBlock', () => {
  let app: App | undefined;
  let host: HTMLElement;

  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    vi.stubGlobal('visualViewport', Object.assign(new EventTarget(), { width: 1024, height: 768 }));
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    app?.unmount();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  async function mount(source: string, context: RepoContext | null) {
    const Parent = defineComponent({
      setup() {
        provideRepoContext(() => context);
        return () => h(MarkdownBlock, { source });
      },
    });
    app = createApp(Parent).use(createVuetify());
    app.mount(host);
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await nextTick();
    }
  }

  it('resolves repo: images against the provided repository and zooms on click', async () => {
    await mount('![list view](repo:docs/list.png)', repo);
    const img = host.querySelector<HTMLImageElement>('.markdown img');
    expect(img?.getAttribute('src')).toBe(
      '/api/projects/p1/raw?ref=cvx%2FCVX-1&path=docs%2Flist.png',
    );
    img?.click();
    for (let i = 0; i < 4; i += 1) await nextTick();
    const zoom = document.querySelector('[data-test="image-zoom"]');
    expect(zoom?.querySelector('img')?.getAttribute('alt')).toBe('list view');
    expect(zoom?.textContent).toContain('Open original');
  });

  it('keeps following links around images instead of zooming', async () => {
    await mount('[![x](https://example.com/x.png)](https://example.com)', null);
    const img = host.querySelector<HTMLImageElement>('.markdown img');
    img?.addEventListener('click', (event) => event.preventDefault());
    img?.click();
    await nextTick();
    expect(document.querySelector('[data-test="image-zoom"]')).toBeNull();
  });

  it('shows the alt text of repo: images outside an issue', async () => {
    await mount('![list view](repo:docs/list.png)', null);
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('list view');
  });
});
