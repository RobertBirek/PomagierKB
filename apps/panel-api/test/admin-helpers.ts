import type { FastifyInstance } from 'fastify';
import { openDb, runMigrations, nowIso, type Db } from '@pomagierkb/shared/db';
import { buildApp } from '../src/app.js';
import { makeTestConfig, type AppConfig } from '../src/config.js';
import { sharedMigrationsDir } from '../src/lib/migrations.js';
import type { Role } from '../src/types.js';

/**
 * Wspólny helper testów modułów admina (settings/mcp-admin/audit/status).
 * Stub sesji szkieletu zawsze daje req.user=null, więc testy dokładają
 * WŁASNY hook onRequest (rejestrowany PO buildApp → biegnie po stubie),
 * który buduje req.user z nagłówków x-test-role / x-test-user.
 */

export interface TestCtx {
  app: FastifyInstance;
  db: Db;
}

/** Wstawia użytkownika (FK dla api_keys/audit); zwraca id. */
export function insertUser(
  db: Db,
  id: string,
  role: Role,
  opts: { kind?: 'oidc' | 'service'; status?: 'active' | 'disabled' } = {},
): string {
  db.prepare(
    `INSERT INTO users (id, sub, email, display_name, kind, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.kind === 'service' ? null : `sub-${id}`,
    `${id}@test.local`,
    id,
    opts.kind ?? 'oidc',
    role,
    opts.status ?? 'active',
    nowIso(),
    nowIso(),
  );
  return id;
}

export async function makeTestApp(configOverrides: Partial<AppConfig> = {}): Promise<TestCtx> {
  const db = openDb(':memory:');
  runMigrations(db, sharedMigrationsDir());
  insertUser(db, 'u-admin', 'admin');
  insertUser(db, 'u-operator', 'operator');
  insertUser(db, 'u-viewer', 'viewer');

  const app = await buildApp({ config: makeTestConfig(configOverrides), db });
  app.addHook('onRequest', async (req) => {
    const role = req.headers['x-test-role'];
    if (role === 'admin' || role === 'operator' || role === 'viewer') {
      const idHeader = req.headers['x-test-user'];
      const id = typeof idHeader === 'string' ? idHeader : `u-${role}`;
      req.user = {
        id,
        email: `${id}@test.local`,
        displayName: id,
        role,
        sessionHash: `sess-${id}`,
      };
    }
  });
  await app.ready();
  return { app, db };
}

/** Nagłówki autoryzacji testowej. */
export function as(role: Role, userId?: string): Record<string, string> {
  return { 'x-test-role': role, ...(userId !== undefined ? { 'x-test-user': userId } : {}) };
}
