import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { nowIso } from '@pomagierkb/shared/db';
import { makeTestApp, as, type TestCtx } from './admin-helpers.js';
import { worstStatus } from '../src/services/status.js';

/**
 * Health cockpit: komponenty z równoległych sond, cache 10 s (drugi call NIE
 * wykonuje sond — licznik w mocku fetch), stan breakerów bez wywołań LLM
 * oraz reset breakera (admin) unieważniający cache.
 */

/** Mock fetch świadomy URL-i: OpenSPG login+list OK, stirling/tika/mcp OK. */
function makeFetchMock() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/v1/accounts/login')) {
      return new Response('{"success":true}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'set-cookie': 'SESSION=test; Path=/' },
      });
    }
    if (url.includes('/v1/projects/list')) {
      return new Response('{"success":true,"result":[{"id":1,"name":"Docs","namespace":"Docs"}]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('ok', { status: 200 });
  });
}

describe('status cockpit', () => {
  let ctx: TestCtx;
  const fetchMock = makeFetchMock();

  beforeAll(async () => {
    vi.stubGlobal('fetch', fetchMock);
    ctx = await makeTestApp();
    // Otwarty breaker LLM — cockpit ma go pokazać BEZ żadnego wywołania LLM.
    ctx.db
      .prepare(
        `INSERT INTO breakers (name, state, reason, failure_count, opened_at, retry_after, updated_at)
         VALUES ('llm.chat', 'open', 'timeout', 3, ?, ?, ?)`,
      )
      .run(nowIso(), new Date(Date.now() + 3_600_000).toISOString(), nowIso());
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await ctx.app.close();
    ctx.db.close();
  });

  it('worstStatus: down > warn > unknown > ok', () => {
    expect(worstStatus(['ok', 'ok'])).toBe('ok');
    expect(worstStatus(['ok', 'unknown'])).toBe('unknown');
    expect(worstStatus(['warn', 'unknown', 'ok'])).toBe('warn');
    expect(worstStatus(['ok', 'down', 'warn'])).toBe('down');
    expect(worstStatus([])).toBe('unknown');
  });

  it('GET /status wymaga zalogowania (401 bez sesji), viewer wystarcza', async () => {
    const anon = await ctx.app.inject({ method: 'GET', url: '/api/v1/status' });
    expect(anon.statusCode).toBe(401);
  });

  it('zwraca cockpit ze wszystkimi komponentami; drugi call z cache (bez sond)', async () => {
    const first = await ctx.app.inject({ method: 'GET', url: '/api/v1/status', headers: as('viewer') });
    expect(first.statusCode).toBe(200);
    const data = first.json().data;

    const ids = (data.components as { id: string }[]).map((c) => c.id);
    expect(ids.sort()).toEqual(
      ['actions', 'backup', 'breakers', 'cert', 'db', 'disk', 'gaps', 'inbox', 'llm', 'mcp', 'openspg', 'stirling', 'tika'].sort(),
    );
    for (const c of data.components as { label: string; status: string; latencyMs: number; detail: string }[]) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(['ok', 'warn', 'down', 'unknown']).toContain(c.status);
      expect(typeof c.latencyMs).toBe('number');
    }

    const byId = Object.fromEntries((data.components as { id: string; status: string }[]).map((c) => [c.id, c.status]));
    expect(byId['db']).toBe('ok');
    expect(byId['openspg']).toBe('ok');
    expect(byId['stirling']).toBe('ok');
    expect(byId['tika']).toBe('ok');
    expect(byId['mcp']).toBe('ok');
    expect(byId['llm']).toBe('down'); // otwarty breaker llm.chat — bez wywołania LLM
    expect(byId['breakers']).toBe('down');
    expect(data.overall).toBe('down'); // worstStatus w polu overall

    const callsAfterFirst = fetchMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Drugi call w oknie 10 s: identyczny payload, ZERO nowych sond.
    const second = await ctx.app.inject({ method: 'GET', url: '/api/v1/status', headers: as('viewer') });
    expect(second.statusCode).toBe(200);
    expect(second.json().data.generatedAt).toBe(data.generatedAt);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('sonda inbox niesie liczbę pendingDrafts wprost (badge w nav bez parsowania detail)', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/status', headers: as('viewer') });
    expect(res.statusCode).toBe(200);
    const inbox = (res.json().data.components as { id: string; detail: string; pendingDrafts?: number }[]).find(
      (c) => c.id === 'inbox',
    );
    expect(inbox).toBeDefined();
    expect(typeof inbox?.pendingDrafts).toBe('number');
    // spójność z detail 'oczekujące: N' (fallback starszych klientów)
    expect(inbox?.detail).toBe(`oczekujące: ${inbox?.pendingDrafts}`);
  });

  it('reset breakera: operator → 403; admin → 200, cache unieważniony, llm wraca do ok', async () => {
    const forbidden = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/status/breakers/llm.chat/reset',
      headers: as('operator'),
    });
    expect(forbidden.statusCode).toBe(403);

    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/status/breakers/nie-ma/reset',
      headers: as('admin'),
    });
    expect(unknown.statusCode).toBe(404);

    const callsBefore = fetchMock.mock.calls.length;
    const reset = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/status/breakers/llm.chat/reset',
      headers: as('admin'),
    });
    expect(reset.statusCode).toBe(200);
    const breakers = reset.json().data.breakers as { name: string; state: string }[];
    expect(breakers.find((b) => b.name === 'llm.chat')?.state).toBe('closed');

    // Cache unieważniony — kolejny /status wykonuje sondy od nowa i widzi zamknięty breaker.
    const status = await ctx.app.inject({ method: 'GET', url: '/api/v1/status', headers: as('viewer') });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore);
    const byId = Object.fromEntries(
      (status.json().data.components as { id: string; status: string }[]).map((c) => [c.id, c.status]),
    );
    expect(byId['llm']).toBe('ok');
    expect(byId['breakers']).toBe('ok');
    expect(status.json().data.overall).toBe('ok');
  });
});
