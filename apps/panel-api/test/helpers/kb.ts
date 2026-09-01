import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, runMigrations, setSetting, nowIso, type Db } from '@pomagierkb/shared/db';
import { seal } from '@pomagierkb/shared/crypto';
import { makeTestConfig, type AppConfig } from '../../src/config.js';
import { sharedMigrationsDir } from '../../src/lib/migrations.js';
import type { AppUser, Role } from '../../src/types.js';

/** Wspólne pomocniki testów modułu KB (baza :memory:, config, seedy). */

export function makeDb(): Db {
  const db = openDb(':memory:');
  runMigrations(db, sharedMigrationsDir());
  return db;
}

/** Config testowy z izolowanym dataDir (logi akcji nie kolidują między testami). */
export function makeKbTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return makeTestConfig({
    dataDir: mkdtempSync(join(tmpdir(), 'kag-kb-test-')),
    ...overrides,
  });
}

/** Wiersz users pod FK actions.started_by / audyt (fałszywa sesja w testach tras). */
export function seedUser(db: Db, id: string, role: Role): AppUser {
  const now = nowIso();
  db.prepare(
    `INSERT INTO users (id, sub, email, display_name, kind, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'oidc', ?, 'active', ?, ?)`,
  ).run(id, `sub-${id}`, `${id}@test`, id, role, now, now);
  return { id, email: `${id}@test`, displayName: id, role, sessionHash: `sess-${id}` };
}

/** Ustawienie 'llm.embeddings' (sealed AES-GCM kluczem z configu) — jak zrobi to agent settings. */
export function seedEmbeddingsSettings(db: Db, config: AppConfig, model: string): void {
  setSetting(
    db,
    'llm.embeddings',
    { model, baseUrl: 'https://llm.test/v1', apiKey: 'sk-test-embeddings' },
    { isSecret: true, seal: (plain) => seal(plain, config.tokenEncKey.toString('base64')) },
  );
}
