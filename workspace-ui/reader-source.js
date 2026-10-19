import MarkdownIt from 'markdown-it';
import { Columns2, Maximize2, Minimize2, Play, Pause, Square, X, RotateCw, Plus, RefreshCw } from 'lucide';

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const markdown = new MarkdownIt({ html: false, breaks: true, linkify: false, typographer: false, maxNesting: 20 });
markdown.validateLink = (href) => {
  if (!/^https?:\/\//i.test(href) || /[\u0000-\u0020\u007f]/.test(href)) return false;
  try { const url = new URL(href); return !url.username && !url.password && ['http:', 'https:'].includes(url.protocol); }
  catch { return false; }
};
// No remote images, SVG, HTML, plugins, highlighting HTML, or automatic requests.
markdown.renderer.rules.image = (tokens, index) => `<span class="md-image">${escape(tokens[index].content)}</span>`;
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};

export function markdownHTML(text) {
  const tokens = markdown.parse(text, {});
  const html = markdown.renderer.render(tokens, markdown.options, {}).replace(/<br>\n/g, '<br>');
  // Plain messages keep their compact shape; structured Markdown keeps its block semantics.
  return tokens.length === 3 && tokens[0].type === 'paragraph_open' && tokens[2].type === 'paragraph_close'
    ? html.slice(3, -5) : html;
}

const icons = { split: Columns2, focus: Maximize2, restore: Minimize2, play: Play, pause: Pause, stop: Square, cancel: X, retry: RotateCw, add: Plus, refresh: RefreshCw };
export function readerIcon(name) {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name].map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([key, value]) => `${key}="${escape(value)}"`).join(' ')}></${tag}>`).join('')}</svg>`;
}
