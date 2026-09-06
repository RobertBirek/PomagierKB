import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { createKey, createProfile } from '@pomagierkb/shared/db';
import { AuthFailureAggregator, isValidProfileId } from '../src/auth.js';
import { makeHarness, makeUser, MCP_HEADERS, toolsListBody, type TestHarness } from './helpers.js';

/**
 * D9-03: publiczny /mcp/* bez limitu przed uwierzytelnieniem zapisywał wiersz do
 * hash-chaina audytu (BEGIN IMMEDIATE na SQLite współdzielonym z panel-api) przy
 * KAŻDYM nieudanym żądaniu, a :profileId ze ścieżki trafiał tam bez walidacji.
 */

interface AuditRow {
  action: string;
  resource_id: string;
  metadata_json: string | null;
}

function authFailedRows(h: TestHarness): AuditRow[] {
  return h.db
    .prepare(
      "SELECT action, resource_id, metadata_json FROM audit WHERE action = 'mcp.auth_failed' ORDER BY seq",
    )
    .all() as AuditRow[];
}

/** Żądanie bez tokenu z konkretnego adresu klienta (X-Forwarded-For za Caddy). */
function anon(app: FastifyInstance, profileId: string, ip: string) {
  return app.inject({
    method: 'POST',
    url: `/mcp/${profileId}`,
    headers: { ...MCP_HEADERS, 'x-forwarded-for': ip },
    payload: toolsListBody(),
  } satisfies InjectOptions);
}

describe('AuthFailureAggregator (czysta logika)', () => {
  it('jeden wpis na okno; kolejne pominięte i policzone dla następnego okna', () => {
    let t = 1_000_000;
    const agg = new AuthFailureAggregator(60_000, () => t);
    expect(agg.record('a')).toEqual({ audit: true, suppressed: 0 });
    for (let i = 0; i < 9; i++) expect(agg.record('a').audit).toBe(false);
    t += 60_001;
    expect(agg.record('a')).toEqual({ audit: true, suppressed: 9 });
  });

  it('różne klucze (prefix|ip|powód) mają niezależne okna', () => {
    const t = 1_000_000;
    const agg = new AuthFailureAggregator(60_000, () => t);
    expect(agg.record('a').audit).toBe(true);
    expect(agg.record('b').audit).toBe(true);
    expect(agg.record('a').audit).toBe(false);
  });
});

describe('isValidProfileId', () => {
  it('przyjmuje slugi, odrzuca ścieżki, wielkie litery i przerosty', () => {
    expect(isValidProfileId('default')).toBe(true);
    expect(isValidProfileId('a-1')).toBe(true);
    expect(isValidProfileId('-zly')).toBe(false);
    expect(isValidProfileId('DEFAULT')).toBe(false);
    expect(isValidProfileId('a/b')).toBe(false);
    expect(isValidProfileId('a'.repeat(65))).toBe(false);
    expect(isValidProfileId('')).toBe(false);
  });
});

describe('shell MCP: bramka przed uwierzytelnieniem', () => {
  let h: TestHarness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it('zalew anonimowych żądań: 401 do limitu, potem 429 — audyt NIE rośnie liniowo', async () => {
    for (let i = 0; i < 20; i++) {
      const res = await anon(h.bundle.app, 'default', '203.0.113.7');
      expect(res.statusCode).toBe(401);
    }
    const blocked = await anon(h.bundle.app, 'default', '203.0.113.7');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();

    // 21 żądań → JEDEN wpis w łańcuchu audytu (agregacja per prefix|IP|powód)
    const rows = authFailedRows(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata_json).toContain('203.0.113.7');
  });

  it('inny adres źródłowy ma własne okno (limit nie jest globalny)', async () => {
    for (let i = 0; i < 21; i++) await anon(h.bundle.app, 'default', '203.0.113.7');
    const other = await anon(h.bundle.app, 'default', '198.51.100.9');
    expect(other.statusCode).toBe(401);
    expect(authFailedRows(h)).toHaveLength(2); // po jednym wpisie na adres
  });

  it('niepoprawny :profileId → 404 BEZ wpisu do audytu (URL nie zasila hash-chaina)', async () => {
    const res = await h.bundle.app.inject({
      method: 'POST',
      url: `/mcp/${encodeURIComponent('../../etc/passwd')}`,
      headers: MCP_HEADERS,
      payload: toolsListBody(),
    });
    expect(res.statusCode).toBe(404);
    expect(authFailedRows(h)).toHaveLength(0);
  });

  it('REGRESJA: poprawne odmowy nadal działają — 401 -32001 i 403 profile_mismatch', async () => {
    const missing = await anon(h.bundle.app, 'default', '203.0.113.1');
    expect(missing.statusCode).toBe(401);
    expect((missing.json() as { error: { code: number } }).error.code).toBe(-32001);

    const userId = makeUser(h.db);
    createProfile(h.db, { id: 'other', name: 'Other', tools: ['kb_list'] });
    const raw = createKey(h.db, userId, 'k', ['read'], 'default', 30).raw;
    const mismatch = await h.bundle.app.inject({
      method: 'POST',
      url: '/mcp/other',
      headers: { ...MCP_HEADERS, authorization: `Bearer ${raw}`, 'x-forwarded-for': '203.0.113.2' },
      payload: toolsListBody(),
    });
    expect(mismatch.statusCode).toBe(403);
    expect((mismatch.json() as { error: { code: number } }).error.code).toBe(-32003);
    const rows = authFailedRows(h);
    expect(rows.some((r) => (r.metadata_json ?? '').includes('profile_mismatch'))).toBe(true);
    // pełny token NIGDY w audycie
    expect(JSON.stringify(rows)).not.toContain(raw);
  });
});

describe('internal /invalidate: limit prób zgadywania sekretu', () => {
  let h: TestHarness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it('zły X-Internal-Token: 401 do limitu, potem 429', async () => {
    const bad = { 'x-internal-token': 'zly-token' };
    for (let i = 0; i < 10; i++) {
      const res = await h.bundle.internal.inject({
        method: 'POST',
        url: '/invalidate',
        headers: bad,
      });
      expect(res.statusCode).toBe(401);
    }
    const blocked = await h.bundle.internal.inject({
      method: 'POST',
      url: '/invalidate',
      headers: bad,
    });
    expect(blocked.statusCode).toBe(429);
  });
});
