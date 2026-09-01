import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, runMigrations, type Db } from '@pomagierkb/shared/db';
import { buildApp } from '../src/app.js';
import { makeTestConfig } from '../src/config.js';
import { sharedMigrationsDir } from '../src/lib/migrations.js';
import { startMockOidc, performLogin, type MockOidc } from './helpers/oidc-mock.js';

/**
 * Macierz RBAC (401/403, deny-by-default, jawna publiczność) i CSRF
 * (Origin/Sec-Fetch-Site) na trasach testowych + realnych (/api/v1/me, /users).
 * Role sesji to snapshoty — sid viewera i admina działają równolegle.
 */

let mock: MockOidc;
let app: FastifyInstance;
let db: Db;
let viewerSid = '';
let adminSid = '';

beforeAll(async () => {
  mock = await startMockOidc();
  db = openDb(':memory:');
  runMigrations(db, sharedMigrationsDir());
  app = await buildApp({
    config: makeTestConfig({
      oidc: { issuer: mock.issuer, clientId: 'kag-panel', clientSecret: 'test-client-secret' },
      rateLimits: { global: 10_000, auth: 1_000, mutation: 1_000 },
    }),
    db,
  });

  // Trasy testowe pokrywające macierz konfiguracji RBAC/CSRF.
  app.get(
    '/api/v1/_operator',
    { config: { rbac: 'operator', audit: false, csrf: false } },
    async () => ({ ok: true, data: { area: 'operator' } }),
  );
  app.get(
    '/api/v1/_default',
    { config: { audit: false, csrf: false } }, // BRAK rbac → domyślnie viewer
    async () => ({ ok: true, data: { area: 'default' } }),
  );
  app.get(
    '/api/v1/_public',
    { config: { public: true, audit: false, csrf: false } }, // jawnie publiczna
    async () => ({ ok: true, data: { area: 'public' } }),
  );
  app.post(
    '/api/v1/_mutation',
    { config: { rbac: 'viewer', audit: false, csrf: true } },
    async () => ({ ok: true, data: { done: true } }),
  );
  await app.ready();

  mock.state.groups = ['kag-viewer'];
  viewerSid = (await performLogin(app, mock)).sid;
  mock.state.sub = 'authentik-sub-admin';
  mock.state.email = 'admin@test.pl';
  mock.state.groups = ['kag-admin'];
  adminSid = (await performLogin(app, mock)).sid;
  if (viewerSid === '' || adminSid === '') throw new Error('setup: logowanie nie powiodło się');
});

afterAll(async () => {
  await app.close();
  db.close();
  await mock.close();
});

describe('RBAC — macierz 401/403', () => {
  it('anonim: trasy z rolą i bez deklaracji → 401; jawnie publiczna → 200', async () => {
    for (const url of ['/api/v1/me', '/api/v1/_operator', '/api/v1/_default', '/api/v1/users']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
      expect(res.json().error.code, url).toBe('unauthorized');
    }
    const pub = await app.inject({ method: 'GET', url: '/api/v1/_public' });
    expect(pub.statusCode).toBe(200);
  });

  it('viewer: viewer-trasy 200; operator 403; admin 403', async () => {
    const cookies = { kag_sid: viewerSid };
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', cookies })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/_default', cookies })).statusCode,
    ).toBe(200); // brak deklaracji = domyślnie viewer

    const op = await app.inject({ method: 'GET', url: '/api/v1/_operator', cookies });
    expect(op.statusCode).toBe(403);
    expect(op.json().error.code).toBe('forbidden');

    const users = await app.inject({ method: 'GET', url: '/api/v1/users', cookies });
    expect(users.statusCode).toBe(403);
  });

  it('admin: hierarchia admin ⊃ operator ⊃ viewer', async () => {
    const cookies = { kag_sid: adminSid };
    for (const url of ['/api/v1/me', '/api/v1/_default', '/api/v1/_operator', '/api/v1/users']) {
      const res = await app.inject({ method: 'GET', url, cookies });
      expect(res.statusCode, url).toBe(200);
    }
  });

  it('nieznane/nieważne cookie sesji → 401 i wyczyszczenie cookie', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      cookies: { kag_sid: 'nie-ma-takiej-sesji' },
    });
    expect(res.statusCode).toBe(401);
    const cleared = res.cookies.find((c) => c.name === 'kag_sid');
    expect(cleared?.value).toBe('');
  });
});

describe('CSRF — Origin i Sec-Fetch-Site na mutacjach', () => {
  const url = '/api/v1/_mutation';

  it('bez nagłówków (klient nie-przeglądarkowy) → 200', async () => {
    const res = await app.inject({ method: 'POST', url, cookies: { kag_sid: viewerSid } });
    expect(res.statusCode).toBe(200);
  });

  it('Origin = publicUrl → 200; obcy Origin → 403 csrf_rejected', async () => {
    const ok = await app.inject({
      method: 'POST',
      url,
      cookies: { kag_sid: viewerSid },
      headers: { origin: 'https://kag.test' },
    });
    expect(ok.statusCode).toBe(200);

    const bad = await app.inject({
      method: 'POST',
      url,
      cookies: { kag_sid: viewerSid },
      headers: { origin: 'https://evil.example' },
    });
    expect(bad.statusCode).toBe(403);
    expect(bad.json().error.code).toBe('csrf_rejected');
  });

  it("Sec-Fetch-Site: 'same-origin'/'none' → 200; 'cross-site' → 403", async () => {
    for (const value of ['same-origin', 'none']) {
      const res = await app.inject({
        method: 'POST',
        url,
        cookies: { kag_sid: viewerSid },
        headers: { 'sec-fetch-site': value },
      });
      expect(res.statusCode, value).toBe(200);
    }
    const bad = await app.inject({
      method: 'POST',
      url,
      cookies: { kag_sid: viewerSid },
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(bad.statusCode).toBe(403);
    expect(bad.json().error.code).toBe('csrf_rejected');
  });

  it('mutacja /auth/logout też jest chroniona (zły Origin → 403, sesja zostaje)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: { kag_sid: viewerSid },
      headers: { origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('csrf_rejected');
    // Sesja przetrwała — viewer nadal zalogowany.
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      cookies: { kag_sid: viewerSid },
    });
    expect(me.statusCode).toBe(200);
  });

  it('GET z csrf:false nie podlega kontroli mimo obcego Origin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      cookies: { kag_sid: viewerSid },
      headers: { origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(200);
  });
});
