import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * Katalog migracji SQL pakietu shared, wyliczany przez resolver Node
 * (exports '@pomagierkb/shared/db' → packages/shared/dist/db/index.js,
 * obok którego build kopiuje migrations/*.sql). Używane przez server.ts
 * i testy (baza :memory: + runMigrations).
 */
export function sharedMigrationsDir(): string {
  const require = createRequire(import.meta.url);
  const dbEntry = require.resolve('@pomagierkb/shared/db');
  return join(dirname(dbEntry), 'migrations');
}
