import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './open.js';
import { nowIso } from './open.js';

/**
 * Migracje: pliki NNNN_nazwa.sql w katalogu migrations, wykonywane w kolejności.
 * Uruchamia WYŁĄCZNIE panel-api (BEGIN EXCLUSIVE serializuje start wielu procesów);
 * mcp-server woła checkMigrations() i odmawia startu przy rozjeździe.
 */

function ensureMigrationsTable(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
}

export function listMigrationFiles(dir: string): { id: number; name: string; path: string }[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((f) => ({ id: Number(f.slice(0, 4)), name: f, path: join(dir, f) }));
}

export function runMigrations(db: Db, dir: string): { applied: string[] } {
  ensureMigrationsTable(db);
  const applied: string[] = [];
  db.exec('BEGIN EXCLUSIVE');
  try {
    const done = new Set(
      (db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[]).map((r) => r.id),
    );
    for (const m of listMigrationFiles(dir)) {
      if (done.has(m.id)) continue;
      db.exec(readFileSync(m.path, 'utf8'));
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        m.id, m.name, nowIso(),
      );
      applied.push(m.name);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { applied };
}

/** Zwraca najwyższe id zastosowanej migracji (0 gdy brak tabeli/wpisów). */
export function currentMigrationId(db: Db): number {
  try {
    const row = db.prepare('SELECT MAX(id) AS id FROM schema_migrations').get() as { id: number | null };
    return row.id ?? 0;
  } catch {
    return 0;
  }
}

/** Dla mcp-server: rzuca, gdy baza nie jest zmigrowana do oczekiwanej wersji. */
export function checkMigrations(db: Db, dir: string): void {
  const files = listMigrationFiles(dir);
  const expected = files.length > 0 ? Math.max(...files.map((f) => f.id)) : 0;
  const current = currentMigrationId(db);
  if (current !== expected) {
    throw new Error(
      `database migration mismatch: db=${current}, expected=${expected} — uruchom najpierw panel-api`,
    );
  }
}
