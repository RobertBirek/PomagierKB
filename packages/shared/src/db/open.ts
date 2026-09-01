import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

/**
 * Otwiera bazę SQLite z pragmami wymaganymi przez współdzielenie panel-api ↔ mcp-server:
 * WAL (wielu czytelników + jeden pisarz bez blokowania), busy_timeout (krótkie kolizje
 * zapisu między procesami), foreign_keys. Wymaga LOKALNEGO systemu plików (nie NFS).
 */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

/** Czas w formacie przyjętym w całym schemacie (ISO-8601 UTC z milisekundami). */
export function nowIso(): string {
  return new Date().toISOString();
}
