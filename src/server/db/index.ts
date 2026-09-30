import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export function openDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(schema.DDL);
  migrate(sqlite);
  return drizzle(sqlite, { schema }) as Db;
}

/** Additive migrations for databases created by earlier versions. */
function migrate(sqlite: Database.Database) {
  const cols = sqlite.prepare("SELECT name FROM pragma_table_info('conversations')").all() as { name: string }[];
  if (!cols.some((c) => c.name === 'engine')) sqlite.exec('ALTER TABLE conversations ADD COLUMN engine TEXT');
}

export { schema };
