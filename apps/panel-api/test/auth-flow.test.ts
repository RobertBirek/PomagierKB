import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, runMigrations, type Db } from '@pomagierkb/shared/db';
import { buildApp } from '../src/app.js';
import { makeTestConfig } from '../src/config.js';
import { sharedMigrationsDir } from '../src/lib/migrations.js';
import { startMockOidc, performLogin, type MockOidc } from './helpers/oidc-mock.js';

/**
 * Pełny przepływ OIDC z mockiem IdP (helpers/oidc-mock.ts): happy-path
 * login→callback→me, walidacja returnTo, brak grupy → 403 HTML, flagi cookie,
 * wygaśnięcie idle/absolutne, leniwy refresh (degradacja roli) i logout.
 */

let mock: MockOidc;
let app: FastifyInstance;
let db: Db;

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
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
  await mock.close();
});

beforeEach(() => {
  mock.reset();
  db.prepare('DELETE FROM sessions').run();
});

function sessionCount(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c;
}

describe('logowanie OIDC — happy path', () => {
  it('login → 302 na IdP z PKCE S256, state i nonce', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/login?returnTo=%2Fpanel' });
    expect(res.statusCode).toBe(302);
    const url = new URL(String(res.headers['location']));
    expect(url.href.startsWith(mock.issuer)).toBe(true);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();
    expect(url.searchParams.get('scope')).toContain('offline_access');
    expect(url.searchParams.get('redirect_uri')).toBe('https://kag.test/auth/callback');
    // Cookie transakcji: HttpOnly, Lax, Path=/auth, Max-Age 600.
    const txn = res.cookies.find((c) => c.name === 'kag_txn');
    expect(txn).toBeDefined();
    expect(txn?.httpOnly).toBe(true);
    expect(String(txn?.sameSite).toLowerCase()).toBe('lax');
    expect(txn?.path).toBe('/auth');
    expect(txn?.maxAge).toBe(600);
  });

  it('callback → sesja + redirect na returnTo; /me zwraca usera i expiresAt', async () => {
    mock.state.groups = ['kag-viewer', 'kag-admin']; // precedencja: admin wygrywa
    const { cbRes, sid } = await performLogin(app, mock, { returnTo: '/panel' });
    expect(cbRes.statusCode).toBe(302);
    expect(cbRes.headers['location']).toBe('/panel');
    expect(sid).not.toBe('');
    expect(sessionCount()).toBe(1);

    const me = await app.inject({ method: 'GET', url: '/api/v1/me', cookies: { kag_sid: sid } });
    expect(me.statusCode).toBe(200);
    const body = me.json() as {
      ok: boolean;
      data: {
        user: { email: string; displayName: string; role: string };
        session: { expiresAt: string };
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.user.email).toBe('jan@test.pl');
    expect(body.data.user.displayName).toBe('Jan Testowy');
    expect(body.data.user.role).toBe('admin');
    expect(Date.parse(body.data.session.expiresAt)).toBeGreaterThan(Date.now());

    // W DB nie ma surowego sid — tylko sha256 (inna wartość niż cookie).
    const row = db.prepare('SELECT id_hash FROM sessions').get() as { id_hash: string };
    expect(row.id_hash).not.toBe(sid);
    expect(row.id_hash).toMatch(/^[0-9a-f]{64}$/);

    // Wpis auth.login w łańcuchu audytu.
    const audit = db
      .prepare("SELECT COUNT(*) AS c FROM audit WHERE action = 'auth.login' AND outcome = 'success'")
      .get() as { c: number };
    expect(audit.c).toBeGreaterThan(0);
  });

  it('flagi cookie kag_sid: HttpOnly, SameSite=Lax, Path=/, host-only, bez Secure w test', async () => {
    const { cbRes } = await performLogin(app, mock);
    const sidCookie = cbRes.cookies.find((c) => c.name === 'kag_sid');
    expect(sidCookie).toBeDefined();
    expect(sidCookie?.httpOnly).toBe(true);
    expect(String(sidCookie?.sameSite).toLowerCase()).toBe('lax');
    expect(sidCookie?.path).toBe('/');
    expect(sidCookie?.domain).toBeUndefined(); // host-only
    expect(sidCookie?.secure ?? false).toBe(false); // Secure tylko w produkcji
    // 256 bitów base64url = 43 znaki bez paddingu.
    expect(sidCookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('returnTo spoza panelu (absolutny URL / protocol-relative) → redirect na /', async () => {
    for (const evil of ['https://evil.example/x', '//evil.example/x']) {
      const { cbRes } = await performLogin(app, mock, { returnTo: evil });
      expect(cbRes.statusCode).toBe(302);
      expect(cbRes.headers['location']).toBe('/');
    }
  });
});

describe('odmowy logowania', () => {
  it('brak grupy kag-* → 403 strona PL text/html, zero sesji', async () => {
    mock.state.groups = ['inna-grupa'];
    const { cbRes, sid } = await performLogin(app, mock);
    expect(cbRes.statusCode).toBe(403);
    expect(String(cbRes.headers['content-type'])).toContain('text/html');
    expect(cbRes.body).toContain('Brak dostępu');
    expect(sid).toBe('');
    expect(sessionCount()).toBe(0);
  });

  it('callback bez cookie kag_txn → 400 validation_error', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/callback?code=x&state=y' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('zły state (podmiana w URL) → 401 unauthorized', async () => {
    const loginRes = await app.inject({ method: 'GET', url: '/auth/login' });
    const authUrl = new URL(String(loginRes.headers['location']));
    mock.state.nonce = authUrl.searchParams.get('nonce') ?? '';
    const txn = loginRes.cookies.find((c) => c.name === 'kag_txn');
    const res = await app.inject({
      method: 'GET',
      url: '/auth/callback?code=test-code&state=zle-state',
      cookies: { kag_txn: txn?.value ?? '' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });
});

describe('TTL sesji', () => {
  it('wygaśnięcie idle → 401 i usunięcie wiersza sesji', async () => {
    const { sid } = await performLogin(app, mock);
    db.prepare('UPDATE sessions SET idle_expires_at = ?').run(
      new Date(Date.now() - 1000).toISOString(),
    );
    const me = await app.inject({ method: 'GET', url: '/api/v1/me', cookies: { kag_sid: sid } });
    expect(me.statusCode).toBe(401);
    expect(sessionCount()).toBe(0);
  });

  it('wygaśnięcie absolutne → 401 mimo świeżego idle', async () => {
    const { sid } = await performLogin(app, mock);
    db.prepare('UPDATE sessions SET absolute_expires_at = ?').run(
      new Date(Date.now() - 1000).toISOString(),
    );
    const me = await app.inject({ method: 'GET', url: '/api/v1/me', cookies: { kag_sid: sid } });
    expect(me.statusCode).toBe(401);
    expect(sessionCount()).toBe(0);
  });
});

describe('leniwy refresh tokenu', () => {
  it('wygasły access token → refresh + degradacja roli wg nowych grup', async () => {
    mock.state.groups = ['kag-admin'];
    mock.state.expiresIn = 0; // access token wygasa natychmiast po zalogowaniu
    const { sid } = await performLogin(app, mock);
    mock.state.refreshGroups = ['kag-viewer']; // Authentik odebrał admina

    const me = await app.inject({ method: 'GET', url: '/api/v1/me', cookies: { kag_sid: sid } });
    expect(me.statusCode).toBe(200);
    expect(mock.state.refreshCalls).toBe(1);
    expect(me.json().data.user.role).toBe('viewer'); // degradacja

    // Zdegradowana sesja nie wchodzi na trasę admina.
    const users = await app.inject({
      method: 'GET',
      url: '/api/v1/users',
      cookies: { kag_sid: sid },
    });
    expect(users.statusCode).toBe(403);

    // Kolejne żądanie nie robi drugiego refreshu (nowy access żyje 3600 s).
    await app.inject({ method: 'GET', url: '/api/v1/me', cookies: { kag_sid: sid } });
    expect(mock.state.refreshCalls).toBe(1);
  });

  it('nieudany refresh → sesja usunięta, 401', async () => {
    mock.state.expiresIn = 0;
    mock.state.failRefresh = true;
    const { sid } = await performLogin(app, mock);
    const me = await app.inject({ method: 'GET', url: '/api/v1/me', cookies: { kag_sid: sid } });
    expect(me.statusCode).toBe(401);
    expect(sessionCount()).toBe(0);
  });
});

describe('wylogowanie', () => {
  it('logout usuwa sesję, czyści cookie i zwraca logoutUrl z id_token_hint', async () => {
    const { sid } = await performLogin(app, mock);
    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: { kag_sid: sid },
    });
    expect(res.statusCode).toBe(200);
    const { logoutUrl } = res.json().data as { logoutUrl: string };
    expect(logoutUrl).toContain('end-session');
    expect(logoutUrl).toContain('id_token_hint=');
    expect(logoutUrl).toContain(encodeURIComponent('https://kag.test/'));

    const cleared = res.cookies.find((c) => c.name === 'kag_sid');
    expect(cleared?.value).toBe('');
    expect(sessionCount()).toBe(0);

    const me = await app.inject({ method: 'GET', url: '/api/v1/me', cookies: { kag_sid: sid } });
    expect(me.statusCode).toBe(401);
  });

  it('logout bez sesji → 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/logout' });
    expect(res.statusCode).toBe(401);
  });
});
