import MarkdownIt from 'markdown-it';

// Escape raw HTML and disable images so viewing agent-written text cannot load remote images.
// Ordinary links remain subject to markdown-it's URL validation and the protections below.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true }).disable('image');

const defaultLinkOpen =
  md.renderer.rules['link_open'] ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules['link_open'] = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  token?.attrSet('target', '_blank');
  token?.attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

export const renderMarkdown = (text: string): string => md.render(text);
