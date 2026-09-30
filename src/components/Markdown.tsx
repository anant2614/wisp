'use client';
import { Marked } from 'marked';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// Raw HTML in model output or previews is shown as text, and only safe link schemes render.
const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html({ text }) {
      return esc(text);
    },
    link({ href, tokens }) {
      const inner = this.parser.parseInline(tokens);
      const ok = /^(https?:|mailto:|\/)/i.test(href);
      return ok ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : inner;
    },
    image({ href, text }) {
      return /^https?:/i.test(href) ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(text || href)}</a>` : esc(text);
    },
  },
});

export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  return <div className={`md ${className}`} dangerouslySetInnerHTML={{ __html: md.parse(text, { async: false }) as string }} />;
}
