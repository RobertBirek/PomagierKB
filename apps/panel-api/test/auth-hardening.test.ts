import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest';
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import { openDb, runMigrations, createKey, nowIso, type Db } from '@pomagierkb/shared/db';
import { buildApp, serializeRequest } from '../src/app.js';
import { makeTestConfig } from '../src/config.js';
import { sharedMigrationsDir } from '../src/lib/migrations.js';
import { resolveTrustProxy, DEFAULT_TRUST_PROXY, TrustProxyError } from '../src/plugins/trust-proxy.js';
import { shouldAudit } from '../src/plugins/audit.js';
import { anonymizeUser, countActiveOidcAdmins, setUserStatus } from '../src/services/users.js';
import { startMockOidc, performLogin, type MockOidc } from './helpers/oidc-mock.js';
import { insertUser, makeTestApp, as } from './admin-helpers.js';

/**
 * Regresje utwardzeń z audytu (grupa G2_auth). Każdy blok pilnuje ustalenia,
 * którego złamanie jest CICHE — bez testu wróciłoby niezauważone:
 * D2-01 trustProxy, D3-01 RBAC przed walidacją, D3-02 flood audytu,
 * D3-04 lockout admina, D4-08 kody OIDC w logu, D9-02 invalidacja cache MCP,
 * D10-06 szum healthchecków, D14-04/05 anonimizacja i PII w audycie.
 */

function makeDb(): Db {
  const db = openDb(':memory:');
  runMigrations(db, sharedMigrationsDir());
  return db;
}

// ── D2-01: trustProxy ───────────────────────────────────────────────────────

describe('D2-01 resolveTrustProxy (czysta logika)', () => {
  it('brak TRUST_PROXY → domyślna lista adresowa (nigdy liczba ani true)', () => {
    const value = resolveTrustProxy({});
    expect(value).toBe(DEFAULT_TRUST_PROXY);
    expect(typeof value).toBe('string');
  });

  it("'false' wyłącza zaufanie do X-Forwarded-For", () => {
    expect(resolveTrustProxy({ TRUST_PROXY: 'false' })).toBe(false);
    expect(resolveTrustProxy({ TRUST_PROXY: 'OFF' })).toBe(false);
  });

  it("'true'/'1' odrzucone — pozwalałyby klientowi podszyć się pod cudze IP", () => {
    expect(() => resolveTrustProxy({ TRUST_PROXY: 'true' })).toThrow(TrustProxyError);
    expect(() => resolveTrustProxy({ TRUST_PROXY: '1' })).toThrow(TrustProxyError);
    expect(() => resolveTrustProxy({ TRUST_PROXY: '*' })).toThrow(TrustProxyError);
  });

  it('lista CIDR jest normalizowana i przekazywana do proxy-addr', () => {
    expect(resolveTrustProxy({ TRUST_PROXY: ' 172.19.0.2 , 10.0.0.0/8 ' })).toBe(
      '172.19.0.2,10.0.0.0/8',
    );
  });
});

describe('D2-01 req.ip pochodzi z X-Forwarded-For (i tylko od zaufanego proxy)', () => {
  let app: FastifyInstance;
  let db: Db;

  beforeAll(async () => {
    db = makeDb();
    app = await buildApp({
      config: makeTestConfig({ rateLimits: { global: 10_000, auth: 1_000, mutation: 1_000 } }),
      db,
    });
    app.get('/_ip', { config: { rbac: false, audit: false, csrf: false } }, async (req) => ({
      ok: true,
      data: { ip: req.ip },
    }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    db.close();
  });

  it('żądanie od zaufanego proxy (loopback) → req.ip = adres klienta z XFF', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/_ip',
      headers: { 'x-forwarded-for': '198.51.100.7' },
    });
    expect(res.json().data.ip).toBe('198.51.100.7');
  });

  it('łańcuch XFF od Caddy (podrzucone + realne) → bierzemy realne, nie podrzucone', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/_ip',
      headers: { 'x-forwarded-for': '1.2.3.4, 198.51.100.7' },
    });
    expect(res.json().data.ip).toBe('198.51.100.7');
  });

  it('XFF od NIEZAUFANEGO źródła jest ignorowany (brak spoofingu IP)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/_ip',
      remoteAddress: '203.0.113.99',
      headers: { 'x-forwarded-for': '198.51.100.7' },
    });
    expect(res.json().data.ip).toBe('203.0.113.99');
  });

  it('brak XFF → req.ip = adres gniazda', async () => {
    const res = await app.inject({ method: 'GET', url: '/_ip', remoteAddress: '203.0.113.5' });
    expect(res.json().data.ip).toBe('203.0.113.5');
  });
});

describe('D2-01 rate limit ma OSOBNY kubełek na każdy adres z X-Forwarded-For', () => {
  it('wyczerpanie limitu przez jednego klienta nie blokuje drugiego', async () => {
    const db = makeDb();
    const app = await buildApp({
      config: makeTestConfig({ rateLimits: { global: 2, auth: 2, mutation: 2 } }),
      db,
    });
    await app.ready();
    try {
      const hit = (ip: string) =>
        app.inject({ method: 'GET', url: '/healthz', headers: { 'x-forwarded-for': ip } });

      expect((await hit('198.51.100.1')).statusCode).toBe(200);
      expect((await hit('198.51.100.1')).statusCode).toBe(200);
      expect((await hit('198.51.100.1')).statusCode).toBe(429);

      // Kluczowa asercja: drugi klient MUSI mieć własny licznik.
      expect((await hit('203.0.113.2')).statusCode).toBe(200);
      expect((await hit('203.0.113.2')).statusCode).toBe(200);
      expect((await hit('203.0.113.2')).statusCode).toBe(429);
    } finally {
      await app.close();
      db.close();
    }
  });
});

// ── D3-01: RBAC przed walidacją ─────────────────────────────────────────────

describe('D3-01 anonim dostaje 401 PRZED walidacją schematu', () => {
  let app: FastifyInstance;
  let db: Db;

  beforeAll(async () => {
    db = makeDb();
    app = await buildApp({
      config: makeTestConfig({ rateLimits: { global: 10_000, auth: 1_000, mutation: 1_000 } }),
      db,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    db.close();
  });

  it('PATCH /users/:id bez sesji z BŁĘDNYM body → 401, bez ujawnienia enumu statusów', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/dowolne-id',
      payload: { status: 'nie-ma-takiego' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
    expect(res.body).not.toContain('allowed values');
  });

  it('POST /users bez sesji z body niezgodnym ze schematem → 401, nie 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      payload: { kind: 'oidc' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('zalogowany nadal dostaje 400 na błędnym body (walidacja niezmieniona)', async () => {
    const ctx = await makeTestApp({ rateLimits: { global: 10_000, auth: 1_000, mutation: 1_000 } });
    try {
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: '/api/v1/users/u-viewer',
        headers: as('admin'),
        payload: { status: 'nie-ma-takiego' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('validation_error');
    } finally {
      await ctx.app.close();
      ctx.db.close();
    }
  });
});

// ── D3-02: audyt nie jest workiem na anonimowe odrzucenia ───────────────────

describe('D3-02 shouldAudit (czysta logika)', () => {
  it('429 nigdy nie trafia do łańcucha (żądanie nie dotarło do handlera)', () => {
    expect(shouldAudit({ statusCode: 429, authenticated: true, hasContext: true })).toBe(false);
  });
  it('sukces zawsze audytowany', () => {
    expect(shouldAudit({ statusCode: 200, authenticated: false, hasContext: false })).toBe(true);
  });
  it('nieudana próba UWIERZYTELNIONEGO aktora audytowana (rozliczalność)', () => {
    expect(shouldAudit({ statusCode: 403, authenticated: true, hasContext: false })).toBe(true);
  });
  it('anonimowy błąd bez kontekstu pomijany, z kontekstem — audytowany', () => {
    expect(shouldAudit({ statusCode: 400, authenticated: false, hasContext: false })).toBe(false);
    expect(shouldAudit({ statusCode: 403, authenticated: false, hasContext: true })).toBe(true);
  });
});

describe('D3-02 /auth/callback bez uwierzytelnienia nie zapycha audytu', () => {
  it('400 „brak transakcji" i 429 nie tworzą wierszy audytu', async () => {
    const db = makeDb();
    const app = await buildApp({
      config: makeTestConfig({ rateLimits: { global: 100, auth: 2, mutation: 100 } }),
      db,
    });
    await app.ready();
    try {
      const first = await app.inject({ method: 'GET', url: '/auth/callback?code=x&state=y' });
      expect(first.statusCode).toBe(400);
      const second = await app.inject({ method: 'GET', url: '/auth/callback?code=x&state=y' });
      expect(second.statusCode).toBe(400);
      const limited = await app.inject({ method: 'GET', url: '/auth/callback?code=x&state=y' });
      expect(limited.statusCode).toBe(429);

      const rows = db
        .prepare("SELECT COUNT(*) AS c FROM audit WHERE action = 'auth.login'")
        .get() as { c: number };
      expect(rows.c).toBe(0);
    } finally {
      await app.close();
      db.close();
    }
  });
});

describe('D3-02/D14-05 logowanie odrzucone przez brak grupy JEST audytowane (bez surowego sub)', () => {
  let mock: MockOidc;
  let app: FastifyInstance;
  let db: Db;

  beforeAll(async () => {
    mock = await startMockOidc();
    db = makeDb();
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

  it('403 bez grupy kag-* → 1 wiersz auth.login z pseudonimem sub', async () => {
    mock.state.sub = 'authentik-sub-bez-grupy';
    mock.state.groups = [];
    const { cbRes } = await performLogin(app, mock);
    expect(cbRes.statusCode).toBe(403);

    const row = db
      .prepare("SELECT metadata_json FROM audit WHERE action = 'auth.login' ORDER BY seq DESC LIMIT 1")
      .get() as { metadata_json: string } | undefined;
    expect(row).toBeDefined();
    const meta = JSON.parse(row?.metadata_json ?? '{}') as Record<string, unknown>;
    expect(meta['event']).toBe('login_denied');
    expect(meta['reason']).toBe('no_group');
    expect(meta['sub']).not.toBe('authentik-sub-bez-grupy');
    expect(String(meta['sub'])).toMatch(/^[0-9a-f]{12}$/);
  });
});

// ── D3-04 / D14-04 / D14-05 / D9-02: konta ──────────────────────────────────

describe('D3-04 blokady wyłączania konta (bez trwałego lockoutu panelu)', () => {
  it('serwis: wyłączenie ostatniego aktywnego admina OIDC → 409 conflict', () => {
    const db = makeDb();
    try {
      insertUser(db, 'u-admin', 'admin');
      expect(countActiveOidcAdmins(db)).toBe(1);
      expect(() => setUserStatus(db, 'u-admin', 'disabled', { actorId: 'u-inny' })).toThrow(
        /ostatni aktywny administrator/,
      );
      expect(
        (db.prepare("SELECT status FROM users WHERE id='u-admin'").get() as { status: string })
          .status,
      ).toBe('active');
    } finally {
      db.close();
    }
  });

  it('serwis: przy dwóch adminach wyłączenie jednego przechodzi', () => {
    const db = makeDb();
    try {
      insertUser(db, 'u-admin', 'admin');
      insertUser(db, 'u-admin2', 'admin');
      expect(setUserStatus(db, 'u-admin2', 'disabled', { actorId: 'u-admin' }).user.status).toBe(
        'disabled',
      );
      expect(countActiveOidcAdmins(db)).toBe(1);
    } finally {
      db.close();
    }
  });

  it('trasa: admin nie może wyłączyć samego siebie → 409', async () => {
    const ctx = await makeTestApp({ rateLimits: { global: 10_000, auth: 1_000, mutation: 1_000 } });
    try {
      insertUser(ctx.db, 'u-admin2', 'admin'); // żeby nie zadziałała blokada „ostatni admin"
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: '/api/v1/users/u-admin',
        headers: as('admin', 'u-admin'),
        payload: { status: 'disabled' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('conflict');
    } finally {
      await ctx.app.close();
      ctx.db.close();
    }
  });
});

describe('D14-04 anonimizacja konta + D14-05 audyt bez danych osobowych + D9-02 invalidacja MCP', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('anonimizacja aktywnego konta → 409; po wyłączeniu → czyści PII i propaguje', async () => {
    const ctx = await makeTestApp({ rateLimits: { global: 10_000, auth: 1_000, mutation: 1_000 } });
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const target = insertUser(ctx.db, 'u-odchodzi', 'operator');
      ctx.db
        .prepare(
          `INSERT OR IGNORE INTO mcp_profiles (id, name, tools_json, enabled, created_at, updated_at)
           VALUES ('default', 'Default', '["kb_search"]', 1, ?, ?)`,
        )
        .run(nowIso(), nowIso());
      const { row: key } = createKey(ctx.db, target, 'klucz', ['read'], 'default', 30);
      ctx.db
        .prepare(
          `INSERT INTO sessions (id_hash, user_id, role, created_at, absolute_expires_at, idle_expires_at)
           VALUES ('hash-odchodzi', ?, 'operator', ?, ?, ?)`,
        )
        .run(target, nowIso(), nowIso(), nowIso());
      ctx.db
        .prepare(
          `INSERT INTO answers (id, question, source, user_id, created_at)
           VALUES ('ans_x', 'Pytanie z danymi osobowymi', 'panel', ?, ?)`,
        )
        .run(target, nowIso());

      // 1) Konto aktywne — anonimizacja odmówiona.
      const tooEarly = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/users/${target}/anonymize`,
        headers: as('admin'),
      });
      expect(tooEarly.statusCode).toBe(409);

      // 2) Wyłączenie: kaskada revoke + invalidacja cache mcp-servera (D9-02).
      const disabled = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/users/${target}`,
        headers: as('admin'),
        payload: { status: 'disabled' },
      });
      expect(disabled.statusCode).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
        `${ctx.app.config.mcpInternalUrl}/invalidate`,
      );

      // 3) Anonimizacja.
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/users/${target}/anonymize`,
        headers: as('admin'),
      });
      expect(res.statusCode).toBe(200);
      const data = res.json().data as {
        user: { email: string | null; displayName: string; sub: string | null };
        detachedAnswers: number;
      };
      expect(data.user.email).toBeNull();
      expect(data.user.displayName).toBe('[użytkownik usunięty]');
      expect(data.user.sub).toMatch(/^anon:[0-9a-f]{64}$/);
      expect(data.detachedAnswers).toBe(1);

      expect(
        (
          ctx.db.prepare('SELECT user_id FROM answers WHERE id = ?').get('ans_x') as {
            user_id: string | null;
          }
        ).user_id,
      ).toBeNull();
      expect(
        (
          ctx.db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?').get(target) as {
            c: number;
          }
        ).c,
      ).toBe(0);
      expect(
        (ctx.db.prepare('SELECT status FROM api_keys WHERE id = ?').get(key.id) as {
          status: string;
        }).status,
      ).toBe('revoked');

      // 4) Audyt: zdarzenia user.* nie utrwalają e-maila, nazwy ani sub.
      const auditRows = ctx.db
        .prepare(
          "SELECT action, before_json, after_json FROM audit WHERE action IN ('user.update','user.anonymize')",
        )
        .all() as { action: string; before_json: string | null; after_json: string | null }[];
      expect(auditRows.length).toBeGreaterThanOrEqual(2);
      for (const row of auditRows) {
        const blob = `${row.before_json ?? ''}${row.after_json ?? ''}`;
        expect(blob).not.toContain('@test.local');
        expect(blob).not.toContain('sub-');
        expect(blob).not.toContain('displayName');
      }
      expect(auditRows.some((r) => r.action === 'user.anonymize')).toBe(true);
    } finally {
      await ctx.app.close();
      ctx.db.close();
    }
  });

  it('serwis: anonimizacja jest idempotentnie zablokowana po pierwszym razie', () => {
    const db = makeDb();
    try {
      insertUser(db, 'u-x', 'viewer', { status: 'disabled' });
      const first = anonymizeUser(db, 'u-x');
      expect(first.user.email).toBeNull();
      expect(() => anonymizeUser(db, 'u-x')).toThrow(/już zanonimizowane/);
    } finally {
      db.close();
    }
  });
});

// ── D4-08: kody OIDC poza logiem ────────────────────────────────────────────

describe('D4-08 serializer żądań do logu nie utrwala query stringu', () => {
  it('/auth/callback?code=... → w logu zostaje sama ścieżka', () => {
    const fake = {
      method: 'GET',
      url: '/auth/callback?code=SEKRETNY_KOD&state=NONCE',
      host: 'kag.test',
      ip: '198.51.100.7',
      socket: { remotePort: 4242 },
    } as unknown as FastifyRequest;
    const out = serializeRequest(fake);
    expect(out['url']).toBe('/auth/callback');
    expect(JSON.stringify(out)).not.toContain('SEKRETNY_KOD');
    expect(JSON.stringify(out)).not.toContain('NONCE');
    expect(out['remoteAddress']).toBe('198.51.100.7');
  });

  it('ścieżka bez query przechodzi bez zmian', () => {
    const out = serializeRequest({ method: 'GET', url: '/healthz' } as unknown as FastifyRequest);
    expect(out['url']).toBe('/healthz');
  });
});

// ── D10-06: healthcheck nie zalewa logu ─────────────────────────────────────

/** Minimalny logger zgodny z kontraktem Fastify — zapamiętuje poziom dzieci. */
function makeSpyLogger(): { logger: FastifyBaseLogger; levels: (string | undefined)[] } {
  const levels: (string | undefined)[] = [];
  const noop = (): void => {};
  const make = (): FastifyBaseLogger =>
    ({
      level: 'info',
      silent: noop,
      info: noop,
      error: noop,
      debug: noop,
      fatal: noop,
      warn: noop,
      trace: noop,
      child(_bindings: unknown, opts?: { level?: string }) {
        levels.push(opts?.level);
        return make();
      },
    }) as unknown as FastifyBaseLogger;
  return { logger: make(), levels };
}

describe('D10-06 logi żądań /healthz wyciszone do warn', () => {
  it('/healthz dostaje logger na poziomie warn, zwykła trasa — nie', async () => {
    const db = makeDb();
    const spy = makeSpyLogger();
    const app = await buildApp({
      config: makeTestConfig({ rateLimits: { global: 10_000, auth: 1_000, mutation: 1_000 } }),
      db,
      logger: spy.logger,
    });
    await app.ready();
    try {
      spy.levels.length = 0;
      await app.inject({ method: 'GET', url: '/healthz' });
      expect(spy.levels).toContain('warn');

      spy.levels.length = 0;
      await app.inject({ method: 'GET', url: '/api/v1/users' }); // 401, ale logowane normalnie
      expect(spy.levels).not.toContain('warn');
    } finally {
      await app.close();
      db.close();
    }
  });
});
