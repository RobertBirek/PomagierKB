import { join } from 'node:path';
import { openDb, runMigrations, orphanSweep } from '@pomagierkb/shared/db';
import { loadConfig } from './config.js';
import { sweepExpired } from './services/sessions.js';
import { buildApp } from './app.js';
import { registerStatics } from './statics.js';
import { sharedMigrationsDir } from './lib/migrations.js';

/**
 * Bootstrap panel-api: config (fail-closed) → openDb → migracje (uruchamia
 * WYŁĄCZNIE panel-api) → sweep osieroconych akcji → buildApp → statyki frontu
 * → sweep sesji co 15 min → listen → graceful shutdown (SIGTERM/SIGINT).
 */

/** Żyje proces o danym pid? (kill z sygnałem 0 — bez wysyłania sygnału) */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const config = loadConfig(); // brak wymaganych ENV → czytelny ConfigError i brak startu

  const db = openDb(join(config.dataDir, 'db', 'kag.db'));
  const { applied } = runMigrations(db, sharedMigrationsDir());

  // Orphan recovery: akcje 'running' z martwym pid → status=error.
  const swept = orphanSweep(db, pidAlive);

  const app = await buildApp({ config, db });
  if (applied.length > 0) app.log.info({ applied }, 'zastosowano migracje');
  if (swept.length > 0) app.log.warn({ actions: swept }, 'posprzątano osierocone akcje');

  await registerStatics(app);

  // Sweep wygasłych sesji co 15 min (unref — nie blokuje zamknięcia procesu).
  const sessionSweepTimer = setInterval(() => {
    try {
      const removed = sweepExpired(db);
      if (removed > 0) app.log.info({ removed }, 'usunięto wygasłe sesje');
    } catch (err) {
      app.log.error({ err }, 'sweep sesji nie powiódł się');
    }
  }, 15 * 60_000);
  sessionSweepTimer.unref();

  // Graceful shutdown: stop nasłuchu, zamknięcie pluginów, zamknięcie bazy.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'zamykanie panel-api');
    clearInterval(sessionSweepTimer);
    void app
      .close()
      .catch((err) => app.log.error({ err }, 'błąd zamykania Fastify'))
      .finally(() => {
        try {
          db.close();
        } catch {
          /* baza mogła już być zamknięta */
        }
        process.exit(0);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  // console.error dozwolony w regułach — logger może jeszcze nie istnieć (błąd configu).
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
