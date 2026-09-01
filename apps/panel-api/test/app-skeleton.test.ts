import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, runMigrations, type Db } from '@pomagierkb/shared/db';
import { buildApp } from '../src/app.js';
import { makeTestConfig } from '../src/config.js';
import { sharedMigrationsDir } from '../src/lib/migrations.js';

/**
 * Testy szkieletu aplikacji: koperta odpowiedzi, 404 vs 405 (+Allow),
 * walidacja JSON Schema, rate limit 429, RBAC deny-by-default.
 * Wzorzec dla agentów modułów: baza :memory: + migracje shared + buildApp
 * z makeTestConfig — bez listen, wszystko przez app.inject().
 */

function makeDb(): Db {
  const db = openDb(':memory:');
  runMigrations(db, sharedMigrationsDir());
  return db;
}

describe('szkielet panel-api', () => {
  let app: FastifyInstance;
  let db: Db;

  beforeAll(async () => {
    db = makeDb();
    app = await buildApp({ config: makeTestConfig(), db });
    // Testowa trasa z walidacją body (additionalProperties:false musi ODRZUCAĆ).
    app.post(
      '/api/v1/_echo',
      {
        config: { rbac: false, audit: false, csrf: false },
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['name'],
            properties: { name: { type: 'string', minLength: 1 } },
          },
        },
      },
      async (req) => ({ ok: true, data: req.body }),
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    db.close();
  });

  it('GET /healthz → 200 z kopertą, bez dotykania upstreamów', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, data: { status: 'ok' } });
  });

  it('nieznana trasa → 404 z kopertą błędu i requestId', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/nie-ma-takiej-trasy' });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('not_found');
    expect(typeof body.error.requestId).toBe('string');
    expect(body.error.requestId.length).toBeGreaterThan(0);
  });

  it('zła metoda na istniejącej ścieżce → 405 + nagłówek Allow', async () => {
    const res = await app.inject({ method: 'POST', url: '/healthz' });
    expect(res.statusCode).toBe(405);
    expect(res.headers['allow']).toContain('GET');
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('method_not_allowed');
  });

  it('walidacja body → 400 validation_error z details[{path,message}]', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/_echo',
      payload: { name: '', extra: 'niedozwolone' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('validation_error');
    expect(Array.isArray(body.error.details)).toBe(true);
    expect(body.error.details.length).toBeGreaterThan(0);
    expect(body.error.details[0]).toHaveProperty('path');
    expect(body.error.details[0]).toHaveProperty('message');
  });

  it('poprawne body przechodzi walidację', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/_echo',
      payload: { name: 'ok' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, data: { name: 'ok' } });
  });

  it('RBAC deny-by-default: trasa z rbac bez sesji → 401 (stub user=null)', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });
});

describe('rate limiting', () => {
  it('przekroczenie globalnego limitu → 429 z kopertą i Retry-After', async () => {
    const db = makeDb();
    const app = await buildApp({
      config: makeTestConfig({ rateLimits: { global: 3, auth: 2, mutation: 2 } }),
      db,
    });
    await app.ready();
    try {
      for (let i = 0; i < 3; i++) {
        const ok = await app.inject({ method: 'GET', url: '/healthz' });
        expect(ok.statusCode).toBe(200);
      }
      const limited = await app.inject({ method: 'GET', url: '/healthz' });
      expect(limited.statusCode).toBe(429);
      const body = limited.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('rate_limited');
      expect(limited.headers['retry-after']).toBeDefined();
    } finally {
      await app.close();
      db.close();
    }
  });
});
