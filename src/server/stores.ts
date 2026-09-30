import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { desc, eq, sql } from 'drizzle-orm';
import type { Db } from './db';
import { conversations, leadRuns, leads, memories, usage } from './db/schema';

export class MemoryStore {
  constructor(private db: Db) {}

  save(text: string, tags: string[] = [], convId?: string) {
    const r = this.db
      .insert(memories)
      .values({ text, tags: tags.join(' '), sourceConvId: convId ?? null, createdAt: Date.now() })
      .returning()
      .get();
    return r;
  }

  /** Full-text search (FTS5, bm25). Falls back to recent memories for an empty query. */
  search(query: string, k = 5) {
    const terms = query
      .toLowerCase()
      .match(/[\p{L}\p{N}]{3,}/gu)
      ?.filter((t) => !STOP.has(t))
      .slice(0, 12);
    if (!terms?.length) return this.list(k);
    const q = terms.map((t) => `"${t}"`).join(' OR ');
    return this.db.$client
      .prepare(
        `SELECT m.id, m.text, m.tags, m.source_conv_id as sourceConvId, m.created_at as createdAt
         FROM memories_fts f JOIN memories m ON m.id = f.rowid
         WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts) LIMIT ?`,
      )
      .all(q, k) as { id: number; text: string; tags: string; createdAt: number }[];
  }

  list(limit = 100) {
    return this.db.select().from(memories).orderBy(desc(memories.id)).limit(limit).all();
  }

  delete(id: number) {
    this.db.delete(memories).where(eq(memories.id, id)).run();
  }
}

const STOP = new Set(
  'the and for with that this from your you are was were have has had but not what when where which who how can will would could should about into than then them they their there these those our out any all get got just also some more most very'.split(
    ' ',
  ),
);

export interface LeadInput {
  sourceUrl: string;
  author?: string;
  subreddit?: string;
  postedAt?: number;
  excerpt?: string;
  intent?: string;
  score: number;
  rationale?: string;
}

export class LeadStore {
  constructor(private db: Db) {}

  saveRun(convId: string | null, product: string, queries: unknown, items: LeadInput[]) {
    const runId = randomUUID();
    const now = Date.now();
    this.db
      .insert(leadRuns)
      .values({ id: runId, convId, product, queryJson: JSON.stringify(queries), createdAt: now })
      .run();
    const seen = new Set<string>();
    for (const l of items) {
      if (seen.has(l.sourceUrl)) continue;
      seen.add(l.sourceUrl);
      this.db
        .insert(leads)
        .values({
          id: randomUUID(),
          runId,
          product,
          sourceUrl: l.sourceUrl,
          author: l.author ?? null,
          subreddit: l.subreddit ?? null,
          postedAt: l.postedAt ?? null,
          excerpt: l.excerpt ?? null,
          intent: l.intent ?? null,
          score: Math.max(0, Math.min(100, Math.round(l.score))),
          rationale: l.rationale ?? null,
          createdAt: now,
        })
        .run();
    }
    return { runId, count: seen.size };
  }

  run(runId: string) {
    return this.db.select().from(leads).where(eq(leads.runId, runId)).orderBy(desc(leads.score)).all();
  }
}

/** Renders a lead run as the Markdown report used for export (flow 13.5 step 4). */
export function renderLeadReport(product: string, rows: ReturnType<LeadStore['run']>, summary?: string): string {
  const esc = (s: string | null | undefined) => (s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  const lines = [
    `# Reddit leads for ${product}`,
    '',
    summary ?? `${rows.length} leads found, sorted by fit score.`,
    '',
    '| Score | Subreddit | Author | Intent | Excerpt | Rationale | Link |',
    '|---:|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.score} | r/${esc(r.subreddit)} | u/${esc(r.author)} | ${esc(r.intent)} | ${esc(r.excerpt).slice(0, 160)} | ${esc(r.rationale)} | [post](${r.sourceUrl}) |`,
    ),
    '',
  ];
  return lines.join('\n');
}

export class ExportStore {
  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  write(filename: string, content: string): { name: string; path: string } {
    let name =
      path
        .basename(filename)
        .replace(/[^\w.\- ]+/g, '_')
        .trim() || 'export.md';
    if (!name.toLowerCase().endsWith('.md')) name += '.md';
    const p = path.join(/*turbopackIgnore: true*/ this.dir, name);
    fs.writeFileSync(p, content);
    return { name, path: p };
  }

  read(name: string): string | undefined {
    const p = path.join(this.dir, path.basename(name));
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined;
  }

  list() {
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(this.dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  }
}

export class ConversationStore {
  constructor(private db: Db) {}

  create(title = 'New conversation') {
    const id = randomUUID();
    const now = Date.now();
    this.db.insert(conversations).values({ id, title, createdAt: now, updatedAt: now }).run();
    return this.get(id)!;
  }

  get(id: string) {
    return this.db.select().from(conversations).where(eq(conversations.id, id)).get();
  }

  list() {
    return this.db.select().from(conversations).orderBy(desc(conversations.updatedAt)).all();
  }

  touch(id: string, patch: { title?: string; sdkSessionId?: string | null } = {}) {
    this.db
      .update(conversations)
      .set({ ...patch, updatedAt: Date.now() })
      .where(eq(conversations.id, id))
      .run();
  }

  delete(id: string) {
    this.db.delete(conversations).where(eq(conversations.id, id)).run();
  }

  addUsage(convId: string, inputTokens: number, outputTokens: number, costUsd: number) {
    this.db.insert(usage).values({ convId, inputTokens, outputTokens, costUsd, createdAt: Date.now() }).run();
  }

  usage(convId?: string) {
    const q = this.db
      .select({
        inputTokens: sql<number>`coalesce(sum(${usage.inputTokens}),0)`,
        outputTokens: sql<number>`coalesce(sum(${usage.outputTokens}),0)`,
        costUsd: sql<number>`coalesce(sum(${usage.costUsd}),0)`,
      })
      .from(usage);
    return (convId ? q.where(eq(usage.convId, convId)) : q).get()!;
  }
}
