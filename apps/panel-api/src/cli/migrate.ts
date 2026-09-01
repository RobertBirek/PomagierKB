import { join } from 'node:path';
import { openDb, runMigrations } from '@pomagierkb/shared/db';
import { sharedMigrationsDir } from '../lib/migrations.js';

/**
 * CLI migracji (root: `npm run migrate` → node apps/panel-api/dist/cli/migrate.js).
 * Normalnie migracje uruchamia bootstrap panel-api (server.ts) — CLI jest do
 * ręcznego domknięcia migracji bez podnoszenia serwera (deploy, diagnostyka).
 * DATA_DIR z env (domyślnie /data — ta sama konwencja co config.ts).
 */
function main(): void {
  const dataDir =
    process.env['DATA_DIR'] !== undefined && process.env['DATA_DIR'] !== ''
      ? process.env['DATA_DIR']
      : '/data'; // jak config.ts (kontener montuje /data)
  const dbPath = join(dataDir, 'db', 'kag.db');
  const db = openDb(dbPath);
  try {
    const { applied } = runMigrations(db, sharedMigrationsDir());
    if (applied.length === 0) {
      process.stdout.write(`migracje: baza ${dbPath} aktualna (nic do zastosowania)\n`);
    } else {
      process.stdout.write(`migracje: zastosowano ${applied.length}: ${applied.join(', ')}\n`);
    }
  } finally {
    db.close();
  }
}

main();
