import { fileURLToPath } from 'node:url';
import { openDb, runMigrations, nowIso, type Db } from '../src/db/index.js';

/** Baza testowa w pamięci ze zmigrowanym schematem. */
export function testDb(): Db {
  const db = openDb(':memory:');
  runMigrations(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
  return db;
}

/** Użytkownik serwisowy do FK (api_keys, drafts). */
export function seedUser(db: Db, id = 'user_test'): string {
  db.prepare(
    `INSERT INTO users (id, display_name, kind, role, status, created_at, updated_at)
     VALUES (?, 'Testowy', 'service', 'operator', 'active', ?, ?)`,
  ).run(id, nowIso(), nowIso());
  return id;
}
