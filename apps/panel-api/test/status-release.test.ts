import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { currentMigrationId } from '@pomagierkb/shared/db';
import { makeTestApp, as, type TestCtx } from './admin-helpers.js';

/**
 * GET /status → blok `release` (tożsamość wydania): sha commita i czas builda
 * z ENV wstrzykiwanych przez obrazy panelu i mcp (Dockerfile: ENV APP_GIT_SHA,
 * APP_BUILT_AT) + wersja schematu bazy z SQLite. Bez tego nie da się zdalnie
 * ustalić, co realnie działa na produkcji ani czy migracje dogoniły obraz.
 */

describe('GET /status — release', () => {
  let ctx: TestCtx;

  beforeAll(async () => {
    ctx = await makeTestApp();
  });
  afterAll(async () => {
    await ctx.app.close();
    ctx.db.close();
  });
  afterEach(() => {
    delete process.env['APP_GIT_SHA'];
    delete process.env['APP_BUILT_AT'];
  });

  it('czyta APP_GIT_SHA/APP_BUILT_AT i wersję migracji, w kopercie {ok,data}', async () => {
    process.env['APP_GIT_SHA'] = '6a1f704c0de1234567890abcdef1234567890abc';
    process.env['APP_BUILT_AT'] = '2026-09-06T10:00:00.000Z';

    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/status', headers: as('viewer') });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; data: { release: Record<string, unknown> } };
    expect(body.ok).toBe(true);
    expect(body.data.release).toEqual({
      gitSha: '6a1f704c0de1234567890abcdef1234567890abc',
      builtAt: '2026-09-06T10:00:00.000Z',
      migrationVersion: currentMigrationId(ctx.db),
    });
    expect(body.data.release['migrationVersion']).toBeGreaterThan(0);
  });

  it('poza obrazem (brak ENV) zwraca null, nigdy zgadywanej wartości', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/status', headers: as('viewer') });
    const release = (res.json() as { data: { release: Record<string, unknown> } }).data.release;
    expect(release['gitSha']).toBeNull();
    expect(release['builtAt']).toBeNull();
    expect(release['migrationVersion']).toBe(currentMigrationId(ctx.db));
  });

  it('/status jest za RBAC (bez roli → 401), więc release nie wycieka anonimowo', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/status' });
    expect(res.statusCode).toBe(401);
  });
});
