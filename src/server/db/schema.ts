import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  sdkSessionId: text('sdk_session_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** Timeline items shown in the chat (user, assistant, tool, approval, handoff, artifact, error). */
export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  convId: text('conv_id').notNull(),
  role: text('role').notNull(),
  contentJson: text('content_json').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const approvals = sqliteTable('approvals', {
  id: text('id').primaryKey(),
  convId: text('conv_id').notNull(),
  toolName: text('tool_name').notNull(),
  inputJson: text('input_json').notNull(),
  previewMd: text('preview_md').notNull(),
  status: text('status').notNull(), // pending | approved | rejected | expired
  note: text('note'),
  createdAt: integer('created_at').notNull(),
  decidedAt: integer('decided_at'),
});

export const handoffs = sqliteTable('handoffs', {
  id: text('id').primaryKey(),
  convId: text('conv_id').notNull(),
  kind: text('kind').notNull(), // captcha | sms | login | other
  url: text('url'),
  instructions: text('instructions').notNull(),
  status: text('status').notNull(), // open | done | cancelled
  createdAt: integer('created_at').notNull(),
});

export const memories = sqliteTable('memories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  text: text('text').notNull(),
  tags: text('tags').notNull().default(''),
  sourceConvId: text('source_conv_id'),
  createdAt: integer('created_at').notNull(),
});

export const leadRuns = sqliteTable('lead_runs', {
  id: text('id').primaryKey(),
  convId: text('conv_id'),
  product: text('product').notNull(),
  queryJson: text('query_json').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const leads = sqliteTable('leads', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  product: text('product').notNull(),
  sourceUrl: text('source_url').notNull(),
  author: text('author'),
  subreddit: text('subreddit'),
  postedAt: integer('posted_at'),
  excerpt: text('excerpt'),
  intent: text('intent'),
  score: integer('score').notNull(),
  rationale: text('rationale'),
  createdAt: integer('created_at').notNull(),
});

export const registryItems = sqliteTable('registry_items', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(), // skill | tool | mcp
  name: text('name').notNull(),
  version: integer('version').notNull(),
  status: text('status').notNull(), // pending | active | disabled | rejected | degraded
  manifestJson: text('manifest_json').notNull(),
  gitSha: text('git_sha'),
  failures: integer('failures').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

export const secretGrants = sqliteTable('secret_grants', {
  id: text('id').primaryKey(),
  registryItemId: text('registry_item_id').notNull(),
  secretName: text('secret_name').notNull(),
  approvedAt: integer('approved_at').notNull(),
});

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  convId: text('conv_id'),
  event: text('event').notNull(),
  detailJson: text('detail_json').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const usage = sqliteTable('usage', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  convId: text('conv_id').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  costUsd: real('cost_usd').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const DDL = `
CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, sdk_session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conv_id TEXT NOT NULL, role TEXT NOT NULL, content_json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS messages_conv ON messages(conv_id, created_at);
CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, conv_id TEXT NOT NULL, tool_name TEXT NOT NULL, input_json TEXT NOT NULL, preview_md TEXT NOT NULL, status TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL, decided_at INTEGER);
CREATE TABLE IF NOT EXISTS handoffs (id TEXT PRIMARY KEY, conv_id TEXT NOT NULL, kind TEXT NOT NULL, url TEXT, instructions TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', source_conv_id TEXT, created_at INTEGER NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(text, tags, content='memories', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN INSERT INTO memories_fts(rowid, text, tags) VALUES (new.id, new.text, new.tags); END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN INSERT INTO memories_fts(memories_fts, rowid, text, tags) VALUES('delete', old.id, old.text, old.tags); END;
CREATE TABLE IF NOT EXISTS lead_runs (id TEXT PRIMARY KEY, conv_id TEXT, product TEXT NOT NULL, query_json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS leads (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, product TEXT NOT NULL, source_url TEXT NOT NULL, author TEXT, subreddit TEXT, posted_at INTEGER, excerpt TEXT, intent TEXT, score INTEGER NOT NULL, rationale TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS registry_items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL, manifest_json TEXT NOT NULL, git_sha TEXT, failures INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS secret_grants (id TEXT PRIMARY KEY, registry_item_id TEXT NOT NULL, secret_name TEXT NOT NULL, approved_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, conv_id TEXT, event TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY AUTOINCREMENT, conv_id TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cost_usd REAL NOT NULL, created_at INTEGER NOT NULL);
`;
