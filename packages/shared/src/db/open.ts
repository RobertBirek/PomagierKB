import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

/**
 * Limit rozmiaru pliku -wal po checkpoincie. Bez niego SQLite nigdy nie skraca dziennika —
 * plik zostaje przy największym rozmiarze, jaki osiągnął (produkcja 2026-10-05: 248 MB po
 * jednej dużej transakcji, przy 1,3 MB żywych ramek). 64 MB mieści zwykłą pracę bez
 * ciągłego przycinania; duża transakcja nadal może chwilowo urosnąć ponad limit.
 */
export const WAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

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
  // ustawienie per połączenie: skraca plik połączenie, które zaczyna dziennik od nowa
  if (path !== ':memory:') db.pragma(`journal_size_limit = ${WAL_SIZE_LIMIT_BYTES}`);
  return db;
}

/** Czas w formacie przyjętym w całym schemacie (ISO-8601 UTC z milisekundami). */
export function nowIso(): string {
  return new Date().toISOString();
}
