import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGUAGES = {
  bash,
  css,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  markdown,
  php,
  python,
  rust,
  scss,
  sql,
  typescript,
  xml,
  yaml,
};
for (const [name, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, language);

const BY_EXTENSION: Record<string, keyof typeof LANGUAGES> = {
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  css: 'css',
  go: 'go',
  ini: 'ini',
  toml: 'ini',
  cfg: 'ini',
  conf: 'ini',
  env: 'ini',
  java: 'java',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  json: 'json',
  md: 'markdown',
  markdown: 'markdown',
  php: 'php',
  py: 'python',
  rs: 'rust',
  scss: 'scss',
  sql: 'sql',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  vue: 'xml',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  yml: 'yaml',
  yaml: 'yaml',
};

const BY_NAME: Record<string, keyof typeof LANGUAGES> = {
  dockerfile: 'dockerfile',
  makefile: 'bash',
  '.env': 'ini',
  '.gitignore': 'bash',
};

/** Largest content that gets highlighted; larger files are shown as plain text. */
export const MAX_HIGHLIGHT_BYTES = 256 * 1024;

/** The highlight.js language of a file path, or null for plain text. */
export function languageOf(path: string): string | null {
  const name = (path.split('/').pop() ?? '').toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  if (name.startsWith('dockerfile')) return 'dockerfile';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return BY_EXTENSION[name.slice(dot + 1)] ?? null;
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * HTML for a file's content: highlight.js output (escaped source plus `<span class="hljs-*">`),
 * reduced to spans with a class attribute; the escaped text for unknown languages and large
 * files.
 */
export function highlight(content: string, path: string): string {
  const language = languageOf(path);
  if (!language || content.length > MAX_HIGHLIGHT_BYTES) return escapeHtml(content);
  const html = hljs.highlight(content, { language, ignoreIllegals: true }).value;
  return DOMPurify.sanitize(html, { ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class'] });
}

/** Split highlighted HTML into lines, reopening spans that cross a line break. */
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let current = '';
  const tag = /<span[^>]*>|<\/span>|\n/g;
  let last = 0;
  for (let match = tag.exec(html); match; match = tag.exec(html)) {
    current += html.slice(last, match.index);
    last = match.index + match[0].length;
    if (match[0] === '\n') {
      lines.push(current + '</span>'.repeat(open.length));
      current = open.join('');
    } else if (match[0] === '</span>') {
      open.pop();
      current += match[0];
    } else {
      open.push(match[0]);
      current += match[0];
    }
  }
  current += html.slice(last);
  lines.push(current);
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}
