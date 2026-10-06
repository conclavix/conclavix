import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';
import { rawUrl } from './code/api';
import type { RepoContext } from './repo-context';

export interface RenderOptions {
  /** Repository that `repo:` image paths resolve against; without one they render as alt text. */
  repo?: RepoContext | null;
  /** Keep single line breaks (comments typed in a text area). */
  breaks?: boolean;
}

/** Elements that load media other than images. markdown-it cannot emit them; this is a second layer. */
const MEDIA_TAGS = ['picture', 'source', 'video', 'audio', 'iframe', 'object', 'embed'];

const REPO_SCHEME = 'repo:';

/** Same-origin routes an image may load from: GETs without side effects, never e.g. the audited archive. */
const SAME_ORIGIN_IMAGE_PATH = /^\/api\/(?:avatars\/[^/]+\/[^/]+|projects\/[^/]+\/raw)$/;

/** Whether `url` stays off this origin or hits only an image route, after the browser's path normalization. */
function allowedOrigin(url: string): boolean {
  const origin = globalThis.location?.origin ?? 'http://localhost';
  let parsed: URL;
  try {
    parsed = new URL(url, origin);
  } catch {
    return false;
  }
  return parsed.origin !== origin || SAME_ORIGIN_IMAGE_PATH.test(parsed.pathname);
}

/**
 * The URL an image may load from: `repo:<path>` becomes the API's raw route, https URLs and
 * same-origin avatar or raw paths stay. Everything else (data:, http:, protocol-relative, other
 * same-origin routes) is refused with null.
 */
export function imageSource(src: string, repo: RepoContext | null): string | null {
  if (src.toLowerCase().startsWith(REPO_SCHEME)) {
    if (!repo) return null;
    let path: string;
    try {
      path = decodeURIComponent(src.slice(REPO_SCHEME.length)).replace(/^\/+/, '');
    } catch {
      return null;
    }
    return path ? rawUrl(repo.projectId, repo.ref, path) : null;
  }
  if (/^https:\/\//i.test(src)) return allowedOrigin(src) ? src : null;
  if (src.startsWith('/') && !src.startsWith('//') && !src.startsWith('/\\'))
    return allowedOrigin(src) ? src : null;
  return null;
}

function createRenderer(breaks: boolean) {
  const md = new MarkdownIt({ html: false, linkify: true, breaks });

  const defaultLinkOpen =
    md.renderer.rules['link_open'] ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules['link_open'] = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    token?.attrSet('target', '_blank');
    token?.attrSet('rel', 'noopener noreferrer nofollow');
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  const defaultImage = md.renderer.rules['image'];
  md.renderer.rules['image'] = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (!token || !defaultImage) return '';
    const repo = (env as { repo?: RepoContext | null } | undefined)?.repo ?? null;
    const src = imageSource(String(token.attrGet('src') ?? ''), repo);
    if (!src)
      return md.utils.escapeHtml(self.renderInlineAsText(token.children ?? [], options, env));
    token.attrSet('src', src);
    token.attrSet('loading', 'lazy');
    return defaultImage(tokens, idx, options, env, self);
  };
  return md;
}

const renderers = { plain: createRenderer(false), breaks: createRenderer(true) };

/**
 * Render agent-written Markdown to HTML that is safe for v-html: raw HTML in the source is
 * escaped by markdown-it, and DOMPurify strips anything that still slips through. Images load
 * only from the project repository (`repo:`), https or this origin.
 */
export function renderRichMarkdown(source: string, options: RenderOptions = {}): string {
  const md = options.breaks ? renderers.breaks : renderers.plain;
  return DOMPurify.sanitize(md.render(source, { repo: options.repo ?? null }), {
    ADD_ATTR: ['target'],
    FORBID_TAGS: MEDIA_TAGS,
    FORBID_ATTR: ['srcset', 'poster', 'background'],
  });
}

const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE', 'TR']);

/**
 * Plain-text excerpt of Markdown for one-line previews (list rows, cards): blocks become lines,
 * list items get a bullet, all markup and links are dropped.
 */
export function markdownToText(source: string): string {
  // An inert document: images in the excerpt's source are never loaded, only their alt text kept.
  const root = new DOMParser().parseFromString(renderRichMarkdown(source), 'text/html').body;
  root.querySelectorAll('img').forEach((img) => img.replaceWith(img.alt));
  const lines: string[] = [];
  const push = (text: string, bullet: boolean): void => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean) lines.push(bullet ? `• ${clean}` : clean);
  };
  const walk = (node: Element): void => {
    for (const child of Array.from(node.children)) {
      if (child.tagName === 'LI') {
        const nested = Array.from(child.children).filter(
          (c) => c.tagName === 'UL' || c.tagName === 'OL',
        );
        const own = Array.from(child.childNodes)
          .filter((c) => !nested.includes(c as Element))
          .map((c) => c.textContent ?? '')
          .join(' ');
        push(own, true);
        nested.forEach(walk);
      } else if (BLOCK_TAGS.has(child.tagName)) {
        push(child.textContent ?? '', false);
      } else {
        walk(child);
      }
    }
  };
  walk(root);
  return lines.join('\n');
}
