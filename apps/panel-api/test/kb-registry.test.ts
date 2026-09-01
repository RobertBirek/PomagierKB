import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createDraft, getAction, getKbOrThrow, type Db } from '@pomagierkb/shared/db';
import { buildApp } from '../src/app.js';
import { clearKbTotalsCache } from '../src/services/kb.js';
import type { AppUser } from '../src/types.js';
import { makeDb, makeKbTestConfig, seedUser } from './helpers/kb.js';

/**
 * Testy tras /api/v1/kbs: create + walidacja namespace, totalsy, PATCH,
 * RBAC, stub 501 buildu i 202 akcji create_kb (ścieżka błędu — OpenSPG
 * nieosiągalny w testach, więc akcja kończy się statusem error).
 * Fałszywa sesja: hook onRequest dodany PO buildApp nadpisuje stub (req.user).
 */

describe('trasy /api/v1/kbs', () => {
  let app: FastifyInstance;
  let db: Db;
  let admin: AppUser;
  let viewer: AppUser;
  /** null = brak sesji (stub); podmieniane per test. */
  let currentUser: AppUser | null = null;

  beforeAll(async () => {
    db = makeDb();
    admin = seedUser(db, 'u-admin', 'admin');
    viewer = seedUser(db, 'u-viewer', 'viewer');
    app = await buildApp({ config: makeKbTestConfig(), db });
    app.addHook('onRequest', async (req) => {
      req.user = currentUser;
    });
    await app.ready();
    currentUser = admin;
  });

  afterAll(async () => {
    await app.close();
    db.close();
  });

  it('POST /kbs tworzy wpis rejestru (201) z documentTypes w config', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/kbs',
      payload: {
        namespace: 'TestDocs',
        name: 'Dokumentacja testowa',
        description: 'Baza do testów',
        documentTypes: [
          { name: 'karta katalogowa', description: 'Karty produktów' },
          { name: 'norma' },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const { data } = res.json();
    expect(data.kb.namespace).toBe('TestDocs');
    expect(data.kb.status).toBe('draft');
    expect(data.kb.projectId).toBeNull();
    expect(data.kb.documentTypes).toEqual([
      { name: 'karta katalogowa', description: 'Karty produktów' },
      { name: 'norma', description: '' },
    ]);
    expect(data.kb.totals).toEqual({ documents: 0, chunks: 0, pendingDrafts: 0 });
  });

  it('POST /kbs z zajętym namespace → 409 conflict', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/kbs',
      payload: { namespace: 'TestDocs', name: 'Duplikat' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('conflict');
  });

  it('POST /kbs waliduje namespace wzorcem (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/kbs',
      payload: { namespace: 'testdocs', name: 'Zła nazwa' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('POST /kbs odrzuca nadmiarowe pola i zduplikowane typy dokumentów', async () => {
    const extra = await app.inject({
      method: 'POST',
      url: '/api/v1/kbs',
      payload: { namespace: 'OtherDocs', name: 'X', extra: 'niedozwolone' },
    });
    expect(extra.statusCode).toBe(400);

    const dupTypes = await app.inject({
      method: 'POST',
      url: '/api/v1/kbs',
      payload: {
        namespace: 'OtherDocs',
        name: 'X',
        documentTypes: [{ name: 'norma' }, { name: 'Norma' }],
      },
    });
    expect(dupTypes.statusCode).toBe(400);
    expect(dupTypes.json().error.message).toContain('zduplikowana');
  });

  it('GET /kbs zwraca rejestr; totalsy liczą pending drafty (cache czyszczony)', async () => {
    createDraft(db, {
      title: 'Szkic testowy',
      content: 'Treść szkicu do testu totalsów.',
      sourceType: 'text',
      namespace: 'TestDocs',
    });
    clearKbTotalsCache(db);

    const list = await app.inject({ method: 'GET', url: '/api/v1/kbs' });
    expect(list.statusCode).toBe(200);
    const items = list.json().data.items;
    const entry = items.find((k: { namespace: string }) => k.namespace === 'TestDocs');
    expect(entry.totals.pendingDrafts).toBe(1);

    const detail = await app.inject({ method: 'GET', url: '/api/v1/kbs/TestDocs' });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.kb.totals.pendingDrafts).toBe(1);
  });

  it('GET /kbs/:namespace → 404 dla nieistniejącej bazy', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/kbs/NopeDocs' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('PATCH /kbs/:namespace zmienia name/description; status przez legalne przejścia', async () => {
    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/v1/kbs/TestDocs',
      payload: { name: 'Nowa nazwa', description: 'Nowy opis' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().data.kb.name).toBe('Nowa nazwa');

    const archived = await app.inject({
      method: 'PATCH',
      url: '/api/v1/kbs/TestDocs',
      payload: { status: 'archived' },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().data.kb.status).toBe('archived');

    // archived jest terminalny — powrót do active jest nielegalny.
    const illegal = await app.inject({
      method: 'PATCH',
      url: '/api/v1/kbs/TestDocs',
      payload: { status: 'active' },
    });
    expect(illegal.statusCode).toBe(409);
    expect(illegal.json().error.code).toBe('conflict');
  });

  it('RBAC: viewer nie tworzy KB (403), brak sesji → 401', async () => {
    currentUser = viewer;
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/v1/kbs',
      payload: { namespace: 'ViewerDocs', name: 'X' },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe('forbidden');

    currentUser = null;
    const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/kbs' });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json().error.code).toBe('unauthorized');
    currentUser = admin;
  });

  it('POST /kbs/:namespace/build → 501 not_implemented (job build-kb w Fazie 4)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/kbs/TestDocs/build' });
    expect(res.statusCode).toBe(501);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('not_implemented');
    expect(body.error.message).toContain('Fazie 4');
  });

  it('GET /kbs/:namespace/jobs → 409 dla bazy bez projektu OpenSPG', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/kbs/TestDocs/jobs' });
    expect(res.statusCode).toBe(409);
  });

  it('POST /kbs z createProject:true → 202 z actionId; akcja kończy się (tu: error, brak OpenSPG)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/kbs',
      payload: { namespace: 'AsyncDocs', name: 'Asynchroniczna', createProject: true },
    });
    expect(res.statusCode).toBe(202);
    const { data } = res.json();
    expect(data.actionId).toMatch(/^act_/);
    expect(data.type).toBe('create_kb');
    expect(data.resource).toBe('kb:AsyncDocs');
    expect(data.logPath).toContain(data.actionId);

    // Job biegnie w tle — czekamy na status terminalny (w teście OpenSPG/settings
    // nie istnieją, więc oczekiwany jest error + KB w statusie error).
    const deadline = Date.now() + 5000;
    let status = 'running';
    while (Date.now() < deadline) {
      status = getAction(db, data.actionId)?.status ?? 'running';
      if (status !== 'running') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(status).toBe('error');
    expect(getKbOrThrow(db, 'AsyncDocs').status).toBe('error');
  });
});
