import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, runMigrations, createKey, nowIso, type Db } from '@pomagierkb/shared/db';
import { buildApp } from '../src/app.js';
import { makeTestConfig } from '../src/config.js';
import { sharedMigrationsDir } from '../src/lib/migrations.js';
import { startMockOidc, performLogin, type MockOidc } from './helpers/oidc-mock.js';

/**
 * /api/v1/users: lista (admin), tworzenie WYŁĄCZNIE kont serwisowych,
 * enable/disable z kaskadową dezaktywacją kluczy API i usunięciem sesji.
 */

let mock: MockOidc;
let app: FastifyInstance;
let db: Db;
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
  await app.ready();

  mock.state.groups = ['kag-admin'];
  adminSid = (await performLogin(app, mock)).sid;
  if (adminSid === '') throw new Error('setup: logowanie admina nie powiodło się');
});

afterAll(async () => {
  await app.close();
  db.close();
  await mock.close();
});

describe('/api/v1/users', () => {
  it('GET → lista zawiera zalogowanego admina OIDC', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users',
      cookies: { kag_sid: adminSid },
    });
    expect(res.statusCode).toBe(200);
    const { users } = res.json().data as {
      users: { email: string | null; kind: string; role: string }[];
    };
    const admin = users.find((u) => u.email === 'jan@test.pl');
    expect(admin).toBeDefined();
    expect(admin?.kind).toBe('oidc');
    expect(admin?.role).toBe('admin');
  });

  it('POST kind:service → 201; user bez sub/email, status active', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      cookies: { kag_sid: adminSid },
      payload: { kind: 'service', displayName: 'Robot MCP' },
    });
    expect(res.statusCode).toBe(201);
    const { user } = res.json().data as {
      user: { id: string; sub: null; email: null; kind: string; role: string; status: string };
    };
    expect(user.kind).toBe('service');
    expect(user.sub).toBeNull();
    expect(user.email).toBeNull();
    expect(user.role).toBe('viewer'); // default ze schematu
    expect(user.status).toBe('active');

    // Mutacja audytowana w hash-chainie.
    const audit = db
      .prepare("SELECT COUNT(*) AS c FROM audit WHERE action = 'user.create' AND outcome = 'success'")
      .get() as { c: number };
    expect(audit.c).toBe(1);
  });

  it('POST kind:oidc → 400 (konta OIDC tworzy wyłącznie logowanie)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      cookies: { kag_sid: adminSid },
      payload: { kind: 'oidc', displayName: 'Podejrzany' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('PATCH disable → kaskadowo unieważnia aktywne klucze API', async () => {
    // Konto serwisowe + profil MCP + aktywny klucz.
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      cookies: { kag_sid: adminSid },
      payload: { kind: 'service', displayName: 'Bot z kluczem', role: 'operator' },
    });
    const serviceId = (created.json().data as { user: { id: string } }).user.id;
    // Migracja shared może już seedować profil 'default' — wtedy go reużywamy.
    db.prepare(
      `INSERT OR IGNORE INTO mcp_profiles (id, name, tools_json, enabled, created_at, updated_at)
       VALUES ('default', 'Default', '["kb_search"]', 1, ?, ?)`,
    ).run(nowIso(), nowIso());
    const { row: key } = createKey(db, serviceId, 'klucz-testowy', ['read'], 'default', 30);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${serviceId}`,
      cookies: { kag_sid: adminSid },
      payload: { status: 'disabled' },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { user: { status: string }; revokedKeys: number };
    expect(data.user.status).toBe('disabled');
    expect(data.revokedKeys).toBe(1);

    const keyRow = db.prepare('SELECT status FROM api_keys WHERE id = ?').get(key.id) as {
      status: string;
    };
    expect(keyRow.status).toBe('revoked');

    // Ponowne włączenie nie przywraca kluczy.
    const enable = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${serviceId}`,
      cookies: { kag_sid: adminSid },
      payload: { status: 'active' },
    });
    expect(enable.statusCode).toBe(200);
    expect((enable.json().data as { revokedKeys: number }).revokedKeys).toBe(0);
    expect(
      (db.prepare('SELECT status FROM api_keys WHERE id = ?').get(key.id) as { status: string })
        .status,
    ).toBe('revoked');
  });

  it('disable użytkownika OIDC usuwa jego sesje (natychmiastowe wylogowanie)', async () => {
    // Drugi użytkownik OIDC (viewer) z żywą sesją.
    mock.state.sub = 'authentik-sub-viewer';
    mock.state.email = 'viewer@test.pl';
    mock.state.groups = ['kag-viewer'];
    const { sid: viewerSid } = await performLogin(app, mock);
    expect(viewerSid).not.toBe('');

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/users',
      cookies: { kag_sid: adminSid },
    });
    const viewer = (list.json().data as { users: { id: string; email: string | null }[] }).users.find(
      (u) => u.email === 'viewer@test.pl',
    );
    expect(viewer).toBeDefined();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${viewer?.id}`,
      cookies: { kag_sid: adminSid },
      payload: { status: 'disabled' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().data as { deletedSessions: number }).deletedSessions).toBe(1);

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      cookies: { kag_sid: viewerSid },
    });
    expect(me.statusCode).toBe(401);
  });

  it('PATCH nieistniejącego → 404', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/nie-ma-takiego',
      cookies: { kag_sid: adminSid },
      payload: { status: 'disabled' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });
});
