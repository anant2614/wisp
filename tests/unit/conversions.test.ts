import { describe, expect, it } from 'vitest';
import { extractBody, extractLinks, htmlToText, markdownToHtml } from '@/server/integrations/google';
import { openDb } from '@/server/db';
import { LeadStore, MemoryStore, renderLeadReport } from '@/server/stores';
import { builtinTools } from '@/server/tools/builtin';
import { buildSystemPrompt } from '@/server/agent/prompt';
import { jsonSchemaToShape } from '@/server/agent/toolServer';
import { z } from 'zod';

describe('Markdown → Google Docs HTML', () => {
  it('converts headings, lists, tables and links, escaping the title', () => {
    const html = markdownToHtml('Leads <Q3>', '# Title\n\n- a\n- b\n\n| A | B |\n|---|---|\n| 1 | [x](https://x.y) |\n');
    expect(html).toContain('<title>Leads &lt;Q3&gt;</title>');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<li>a</li>');
    expect(html).toContain('<table>');
    expect(html).toContain('<a href="https://x.y">x</a>');
  });
});

describe('email parsing', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64url');
  it('prefers text/plain and falls back to HTML', () => {
    expect(
      extractBody({
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: b64('plain') } },
          { mimeType: 'text/html', body: { data: b64('<b>h</b>') } },
        ],
      }),
    ).toBe('plain');
    expect(
      extractBody({
        mimeType: 'multipart/alternative',
        parts: [{ mimeType: 'text/html', body: { data: b64('<p>Hi <a href="https://v.example/ok">verify</a></p>') } }],
      }),
    ).toBe('Hi verify (https://v.example/ok)');
  });
  it('extracts unique links without trailing punctuation', () => {
    expect(extractLinks('Go to https://a.example/x?y=1. Or https://a.example/x?y=1')).toEqual(['https://a.example/x?y=1']);
    expect(htmlToText('a&amp;b<br>c')).toBe('a&b\nc');
  });
});

describe('Reddit leads', () => {
  const run = builtinTools.find((t) => t.name === 'leads_save')!;
  it("parses the model's scored leads, dedupes by URL, clamps scores and renders a sorted report", async () => {
    const db = openDb(':memory:');
    const leads = new LeadStore(db);
    const args = z.object(run.schema).parse({
      product: 'Invoicely',
      queries: ['looking for invoicing'],
      leads: [
        {
          source_url: 'https://reddit.com/1',
          author: 'a',
          subreddit: 'smallbusiness',
          score: 40,
          intent: 'buying',
          excerpt: 'need | invoices',
          rationale: 'r1',
          posted_at: '2026-09-01',
        },
        {
          source_url: 'https://reddit.com/2',
          author: 'b',
          subreddit: 'freelance',
          score: 91.6,
          intent: 'buying',
          rationale: 'r2',
        },
        { source_url: 'https://reddit.com/1', author: 'a', subreddit: 'smallbusiness', score: 10 },
      ],
    });
    const out = (await run.handler(args, { convId: 'c', services: { leads } as never })) as string;
    expect(out).toContain('Saved 2 leads');
    const rows = out.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Score'));
    expect(rows[0]).toMatch(/^\| 92 \| r\/freelance/);
    expect(rows[1]).toContain('need \\| invoices');
    expect(z.object(run.schema).safeParse({ product: 'x', queries: [], leads: [{ source_url: 'u', score: 150 }] }).success).toBe(
      false,
    );
  });
  it('renders an empty report', () => {
    expect(renderLeadReport('X', [])).toContain('0 leads found');
  });
});

describe('memory', () => {
  it('full-text searches memories and ignores stop words', () => {
    const m = new MemoryStore(openDb(':memory:'));
    m.save('User prefers aisle seats on flights', ['travel']);
    m.save('Invoicely is the product we sell', ['work']);
    expect(m.search('what seats do I like on flights?')[0].text).toContain('aisle');
    expect(m.search('the and for')).toHaveLength(2); // falls back to recent
  });
});

describe('system prompt', () => {
  it('lists skills, memories, integrations and never includes secrets', () => {
    const p = buildSystemPrompt({
      memories: [{ id: 1, text: 'Likes concise answers' }],
      skills: [{ name: 'reddit-lead-search', description: 'Find leads', dir: '/x' }],
      integrations: [
        {
          cfg: { name: 'notion', registryName: 'io.example/notion', transport: 'http', auth: { type: 'oauth' } },
          connected: false,
        },
      ],
      sandboxTools: [{ name: 'wc', description: 'count words', degraded: true }],
      accounts: { agent: 'bot@example.com' },
      now: new Date('2026-09-30T12:00:00Z'),
    });
    expect(p).toContain('Today is 2026-09-30');
    expect(p).toContain('- reddit-lead-search: Find leads');
    expect(p).toContain('Likes concise answers');
    expect(p).toContain('NOT connected');
    expect(p).toContain('DEGRADED');
    expect(p).toContain('Agent inbox (your own address for sign-ups and verification emails): bot@example.com');
  });
});

describe('agent-written tool schemas', () => {
  it('converts JSON Schema into a zod shape', () => {
    const shape = jsonSchemaToShape({
      type: 'object',
      properties: { text: { type: 'string' }, n: { type: 'number' } },
      required: ['text'],
    });
    const s = z.object(shape);
    expect(s.safeParse({ text: 'a' }).success).toBe(true);
    expect(s.safeParse({ n: 1 }).success).toBe(false);
  });
});
