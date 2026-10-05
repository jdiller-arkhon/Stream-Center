import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * SQLite via Node's built-in `node:sqlite` (bundled with Electron's Node runtime),
 * so the app ships no native modules that need ABI-specific rebuilds.
 */
export type Db = DatabaseSync;

const MIGRATIONS: string[] = [
  // 1: initial schema. Documents are stored as validated JSON with indexed columns for queries.
  `
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE profiles (id TEXT PRIMARY KEY, doc TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE sessions (id TEXT PRIMARY KEY, doc TEXT NOT NULL, state TEXT NOT NULL, started_at TEXT NOT NULL);
  CREATE INDEX sessions_started ON sessions(started_at DESC);
  CREATE TABLE clips (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    content_hash TEXT NOT NULL,
    game_title TEXT,
    session_id TEXT,
    favorite INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    doc TEXT NOT NULL
  );
  CREATE INDEX clips_hash ON clips(content_hash);
  CREATE INDEX clips_imported ON clips(imported_at DESC);
  CREATE TABLE projects (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, doc TEXT NOT NULL);
  CREATE TABLE jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, doc TEXT NOT NULL, spec TEXT NOT NULL);
  CREATE INDEX jobs_created ON jobs(created_at DESC);
  `,
];

export function openDatabase(file: string | ':memory:'): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function kvGet<T>(db: Db, key: string): T | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : null;
}

export function kvSet(db: Db, key: string, value: unknown): void {
  db.prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}
