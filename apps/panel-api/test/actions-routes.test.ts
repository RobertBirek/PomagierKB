import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  openDb,
  runMigrations,
  startAction as repoStartAction,
  updateActionProgress,
  finishAction,
  type ActionRow,
  type Db,
} from '@pomagierkb/shared/db';
import { buildApp } from '../src/app.js';
import { makeTestConfig } from '../src/config.js';
import { sharedMigrationsDir } from '../src/lib/migrations.js';
import type { Role } from '../src/types.js';

/**
 * Testy tras /api/v1/actions (lista, szczegóły+logTail, log, cancel, SSE).
 * Wiersze akcji wstawiane wprost przez repo (bez spawnu — E2E robi
 * actions-runner.test.ts). Rola nadawana testowym hookiem onRequest z nagłówka
 * x-test-role (hook dodany PO buildApp biegnie po stubie sesji).
 * SSE przez prawdziwy listen na porcie efemerycznym (stabilniejsze niż inject).
 */

let dataDir: string;
let db: Db;
let app: FastifyInstance;
let baseUrl: string;

function asRole(role: Role): Record<string, string> {
  return { 'x-test-role': role };
}

/** Wstawia wiersz akcji z własnym plikiem logu w katalogu tymczasowym. */
function seedAction(type: string, resource: string, logLines: string[] = []): ActionRow {
  const logPath = join(dataDir, `${type}-${Math.random().toString(16).slice(2)}.log`);
  writeFileSync(logPath, logLines.map((l) => `${l}\n`).join(''));
  return repoStartAction(db, type, resource, {}, null, logPath);
}

/** Parsuje surowy strumień SSE na listę {event,data}. */
function parseSse(text: string): { event: string; data: unknown }[] {
  const events: { event: string; data: unknown }[] = [];
  for (const block of text.split('\n\n')) {
    const eventLine = block.split('\n').find((l) => l.startsWith('event: '));
    const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
    if (eventLine === undefined || dataLine === undefined) continue; // komentarze/heartbeat
    events.push({ event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) });
  }
  return events;
}

/** Czyta całą odpowiedź SSE aż serwer zamknie strumień (z twardym timeoutem). */
async function readSseUntilEnd(url: string, timeoutMs = 8_000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: asRole('viewer'), signal: ctrl.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    let text = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      text += Buffer.from(chunk).toString('utf8');
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'pomagierkb-actions-routes-'));
  db = openDb(join(dataDir, 'db', 'kag.db'));
  runMigrations(db, sharedMigrationsDir());
  app = await buildApp({ config: makeTestConfig({ dataDir }), db });
  // Testowa "sesja": rola z nagłówka x-test-role (biegnie PO stubie sesji).
  app.addHook('onRequest', async (req) => {
    const role = req.headers['x-test-role'];
    if (role === 'viewer' || role === 'operator' || role === 'admin') {
      req.user = {
        id: 'u-test',
        email: 'test@kag.test',
        displayName: 'Testowy',
        role,
        sessionHash: 'f'.repeat(64),
      };
    }
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('brak adresu nasłuchu');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('GET /api/v1/actions', () => {
  it('bez sesji → 401 (deny-by-default)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/actions' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });

  it('lista z filtrem status i paginacją w meta', async () => {
    const running = seedAction('noop', 'list:running');
    const done = seedAction('noop', 'list:done');
    finishAction(db, done.id, 0);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/actions?status=running&limit=10',
      headers: asRole('viewer'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    const ids = body.data.items.map((a: { id: string }) => a.id);
    expect(ids).toContain(running.id);
    expect(ids).not.toContain(done.id);
    expect(body.meta).toMatchObject({ page: 1, limit: 10 });
    // DTO: statusLabel ze słownika PL, bez surowych kolumn *_json.
    const item = body.data.items.find((a: { id: string }) => a.id === running.id);
    expect(item.statusLabel).toBe('w trakcie');
    expect(item.progress).toBeNull();
    expect(item).not.toHaveProperty('params_json');
  });

  it('nieznany filtr/status → 400 validation_error', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/actions?status=zombie',
      headers: asRole('viewer'),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });
});

describe('GET /api/v1/actions/:id (+log)', () => {
  it('szczegóły z logTail — ostatnie 200 linii', async () => {
    const lines = Array.from({ length: 250 }, (_, i) => `linia-${i + 1}`);
    const row = seedAction('noop', 'detail:tail', lines);
    updateActionProgress(db, row.id, { phase: 'praca', current: 2, total: 3, message: 'w toku' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/actions/${row.id}`,
      headers: asRole('viewer'),
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.id).toBe(row.id);
    expect(data.progress).toEqual({ phase: 'praca', current: 2, total: 3, message: 'w toku' });
    expect(data.logTail).toHaveLength(200);
    expect(data.logTail[0]).toBe('linia-51');
    expect(data.logTail[199]).toBe('linia-250');
  });

  it('nieistniejące id → 404; złe id → 400', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/actions/act_20260901_00000000',
      headers: asRole('viewer'),
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('not_found');

    const invalid = await app.inject({
      method: 'GET',
      url: '/api/v1/actions/zupelnie-zle-id',
      headers: asRole('viewer'),
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('GET /:id/log → pełny log text/plain', async () => {
    const row = seedAction('noop', 'detail:log', ['pierwsza', 'druga']);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/actions/${row.id}/log`,
      headers: asRole('viewer'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toBe('pierwsza\ndruga\n');
  });
});

describe('POST /api/v1/actions/:id/cancel', () => {
  it('viewer → 403; operator na running (bez pid) → 202 cancelled', async () => {
    const row = seedAction('noop', 'cancel:route');

    const forbidden = await app.inject({
      method: 'POST',
      url: `/api/v1/actions/${row.id}/cancel`,
      headers: asRole('viewer'),
    });
    expect(forbidden.statusCode).toBe(403);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/actions/${row.id}/cancel`,
      headers: asRole('operator'),
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe('cancelled');
    expect(body.data.statusLabel).toBe('anulowana');
    // Mutacja audytowana (action.cancel w hash-chainie).
    const audit = db
      .prepare("SELECT resource_id FROM audit WHERE action = 'action.cancel' ORDER BY seq DESC LIMIT 1")
      .get() as { resource_id: string } | undefined;
    expect(audit?.resource_id).toBe(row.id);
  });

  it('akcja zakończona → 409 conflict', async () => {
    const row = seedAction('noop', 'cancel:finished');
    finishAction(db, row.id, 0);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/actions/${row.id}/cancel`,
      headers: asRole('operator'),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('conflict');
  });
});

describe('GET /api/v1/actions/:id/events (SSE)', () => {
  it('nieistniejąca akcja → 404 kopertą (bez hijacku)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/actions/act_20260901_ffffffff/events',
      headers: asRole('viewer'),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('akcja terminalna → replay logu + progress + status i koniec strumienia', async () => {
    const row = seedAction('noop', 'sse:terminal', ['log-a', 'log-b']);
    updateActionProgress(db, row.id, { phase: 'domykanie', current: 3, total: 3 });
    finishAction(db, row.id, 0);

    const text = await readSseUntilEnd(`${baseUrl}/api/v1/actions/${row.id}/events`);
    const events = parseSse(text);
    const byName = (n: string): unknown[] => events.filter((e) => e.event === n).map((e) => e.data);

    expect(byName('progress')).toEqual([{ phase: 'domykanie', current: 3, total: 3 }]);
    const logLines = byName('log').flatMap((d) => (d as { lines: string[] }).lines);
    expect(logLines).toEqual(['log-a', 'log-b']);
    const statuses = byName('status') as { status: string; exitCode: number; label: string }[];
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ status: 'success', exitCode: 0, label: 'zakończona pomyślnie' });
  });

  it('akcja żywa → przyrostowe eventy log/progress, status na terminalu kończy strumień', async () => {
    const row = seedAction('noop', 'sse:live', ['start']);

    // Mutacje w tle w trakcie otwartego strumienia (poll co 100 ms w nodeEnv=test).
    const mutate = (async (): Promise<void> => {
      await new Promise((r) => setTimeout(r, 250));
      appendFileSync(row.log_path, 'przyrost-1\n');
      updateActionProgress(db, row.id, { phase: 'praca', current: 1, total: 2 });
      await new Promise((r) => setTimeout(r, 250));
      appendFileSync(row.log_path, 'przyrost-2\n');
      finishAction(db, row.id, 0);
    })();

    const text = await readSseUntilEnd(`${baseUrl}/api/v1/actions/${row.id}/events`);
    await mutate;

    const events = parseSse(text);
    const logLines = events
      .filter((e) => e.event === 'log')
      .flatMap((e) => (e.data as { lines: string[] }).lines);
    expect(logLines).toEqual(['start', 'przyrost-1', 'przyrost-2']);
    expect(events.some((e) => e.event === 'progress')).toBe(true);
    const last = events[events.length - 1]!;
    expect(last.event).toBe('status');
    expect((last.data as { status: string }).status).toBe('success');
  });
});
