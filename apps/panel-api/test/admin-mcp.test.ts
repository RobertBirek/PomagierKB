import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest';
import { verifyKey } from '@pomagierkb/shared/db';
import { makeTestApp, as, insertUser, type TestCtx } from './admin-helpers.js';

/**
 * Administracja MCP: profile (CRUD, walidacja repo), klucze (raw JEDEN raz,
 * reguły ról, rotate unieważnia stary hash — verify przez repo), best-effort
 * invalidate cache mcp-servera oraz snippety (URL profilu, bez prawdziwego klucza).
 */

describe('mcp-admin', () => {
  let ctx: TestCtx;
  const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));

  beforeAll(async () => {
    vi.stubGlobal('fetch', fetchMock);
    ctx = await makeTestApp();
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await ctx.app.close();
    ctx.db.close();
  });
  afterEach(() => {
    fetchMock.mockClear();
  });

  // ── Profile ───────────────────────────────────────────────────────────────

  it('GET /mcp/profiles (viewer) zawiera seedowany profil default', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/mcp/profiles', headers: as('viewer') });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().data as { id: string }[]).map((p) => p.id);
    expect(ids).toContain('default');
  });

  it('POST /mcp/profiles: admin tworzy; operator → 403; nieznane narzędzie → 400', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/mcp/profiles',
      headers: as('admin'),
      payload: { id: 'lighting-read', name: 'Lighting read', tools: ['kb_search', 'kb_list'] },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data).toMatchObject({ id: 'lighting-read', tools: ['kb_search', 'kb_list'], enabled: true });

    const forbidden = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/mcp/profiles',
      headers: as('operator'),
      payload: { id: 'x', name: 'x', tools: ['kb_search'] },
    });
    expect(forbidden.statusCode).toBe(403);

    const badTool = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/mcp/profiles',
      headers: as('admin'),
      payload: { id: 'bad', name: 'bad', tools: ['kb_hack'] },
    });
    expect(badTool.statusCode).toBe(400);
  });

  it('PATCH i DELETE profilu (admin); DELETE z aktywnym kluczem → 409', async () => {
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/mcp/profiles/lighting-read',
      headers: as('admin'),
      payload: { name: 'Zmieniona nazwa' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().data.name).toBe('Zmieniona nazwa');

    // Klucz aktywny na profilu blokuje usunięcie.
    const key = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/mcp/keys',
      headers: as('admin'),
      payload: { label: 'blokujący', profileId: 'lighting-read', ttlDays: 30 },
    });
    expect(key.statusCode).toBe(201);
    const del = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/mcp/profiles/lighting-read',
      headers: as('admin'),
    });
    expect(del.statusCode).toBe(409);
  });

  // ── Klucze ────────────────────────────────────────────────────────────────

  it('POST /mcp/keys zwraca raw DOKŁADNIE raz; w DB tylko hash; GET nigdy nie zwraca raw', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/mcp/keys',
      headers: as('operator'),
      payload: { label: 'mój klucz', profileId: 'default' },
    });
    expect(res.statusCode).toBe(201);
    const { key, raw } = res.json().data;
    expect(raw).toMatch(/^sk-/);
    expect(key.prefix).toBe(raw.slice(0, key.prefix.length));
    expect(key.scopes).toEqual(['read']);
    expect(key.userId).toBe('u-operator');
    // ttlDays default 90 — expires_at ~90 dni w przód.
    const days = (Date.parse(key.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThan(91);

    // raw weryfikowalny przez repo (sha256 w DB).
    expect(verifyKey(ctx.db, raw)?.id).toBe(key.id);
    // Nigdzie w DB nie ma raw w postaci jawnej.
    const row = ctx.db.prepare('SELECT hash FROM api_keys WHERE id = ?').get(key.id) as { hash: string };
    expect(row.hash).not.toBe(raw);

    // GET /mcp/keys nie zawiera raw ani hasha.
    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/mcp/keys', headers: as('operator') });
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).not.toContain(raw);
    expect(JSON.stringify(list.json())).not.toContain(row.hash);
  });

  it('operator nie wystawi klucza write ani klucza dla innego usera; admin tak', async () => {
    const write = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/mcp/keys',
      headers: as('operator'),
      payload: { label: 'w', profileId: 'default', scopes: ['read', 'write'] },
    });
    expect(write.statusCode).toBe(403);

    const forOther = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/mcp/keys',
      headers: as('operator'),
      payload: { label: 'x', profileId: 'default', userId: 'u-viewer' },
    });
    expect(forOther.statusCode).toBe(403);

    insertUser(ctx.db, 'svc-agent', 'viewer', { kind: 'service' });
    const adminWrite = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/mcp/keys',
      headers: as('admin'),
      payload: { label: 'serwisowy write', profileId: 'default', userId: 'svc-agent', scopes: ['read', 'write'], ttlDays: 7 },
    });
    expect(adminWrite.statusCode).toBe(201);
    expect(adminWrite.json().data.key).toMatchObject({ userId: 'svc-agent', scopes: ['read', 'write'] });
  });

  it('viewer widzi tylko własne klucze; admin wszystkie + filtr ?userId=', async () => {
    const viewer = await ctx.app.inject({ method: 'GET', url: '/api/v1/mcp/keys', headers: as('viewer') });
    expect(viewer.statusCode).toBe(200);
    expect(viewer.json().data).toEqual([]);
    // Filtr userId nie dla nie-adminów.
    const filtered = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/mcp/keys?userId=u-operator',
      headers: as('viewer'),
    });
    expect(filtered.statusCode).toBe(403);

    const all = await ctx.app.inject({ method: 'GET', url: '/api/v1/mcp/keys', headers: as('admin') });
    expect((all.json().data as unknown[]).length).toBeGreaterThan(1);
    const one = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/mcp/keys?userId=u-operator',
      headers: as('admin'),
    });
    const rows = one.json().data as { userId: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.userId === 'u-operator')).toBe(true);
  });

  it('rotate unieważnia stary raw natychmiast (verify przez repo) i woła invalidate mcp', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/mcp/keys',
      headers: as('operator'),
      payload: { label: 'do rotacji', profileId: 'default', ttlDays: 30 },
    });
    const { key, raw: oldRaw } = created.json().data;
    expect(verifyKey(ctx.db, oldRaw)).not.toBeNull();

    fetchMock.mockClear();
    const rotated = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/mcp/keys/${key.id}/rotate`,
      headers: as('operator'),
    });
    expect(rotated.statusCode).toBe(200);
    const { key: newKey, raw: newRaw } = rotated.json().data;
    expect(newRaw).not.toBe(oldRaw);
    // Stary hash martwy natychmiast, nowy działa.
    expect(verifyKey(ctx.db, oldRaw)).toBeNull();
    expect(verifyKey(ctx.db, newRaw)?.id).toBe(newKey.id);

    // Best-effort invalidate: POST <mcpInternalUrl>/invalidate z X-Internal-Token.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://kag-mcp.test:8091/invalidate');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('x-internal-token')).toBe('test-internal-token');
  });

  it('rotate/revoke cudzego klucza: nie-właściciel → 403, właściciel/admin → OK; invalidate best-effort mimo błędu sieci', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/mcp/keys',
      headers: as('operator'),
      payload: { label: 'do revoke', profileId: 'default', ttlDays: 30 },
    });
    const { key, raw } = created.json().data;

    const notOwner = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/mcp/keys/${key.id}/revoke`,
      headers: as('viewer'),
    });
    expect(notOwner.statusCode).toBe(403);

    // Awaria mcp-servera nie psuje odpowiedzi (best-effort, tylko log).
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const revoked = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/mcp/keys/${key.id}/revoke`,
      headers: as('admin'),
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().data.key.status).toBe('revoked');
    expect(verifyKey(ctx.db, raw)).toBeNull();
  });

  it('limit 5 aktywnych kluczy na użytkownika → 409', async () => {
    insertUser(ctx.db, 'u-limit', 'operator');
    for (let i = 0; i < 5; i++) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/mcp/keys',
        headers: as('operator', 'u-limit'),
        payload: { label: `k${i}`, profileId: 'default', ttlDays: 10 },
      });
      expect(res.statusCode).toBe(201);
    }
    const sixth = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/mcp/keys',
      headers: as('operator', 'u-limit'),
      payload: { label: 'k5', profileId: 'default', ttlDays: 10 },
    });
    expect(sixth.statusCode).toBe(409);
  });

  // ── Snippety i health ─────────────────────────────────────────────────────

  it('GET /mcp/snippets zawiera URL profilu i placeholder, NIGDY prawdziwego klucza', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/mcp/snippets?profileId=default',
      headers: as('viewer'),
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.url).toBe('https://kag.test/mcp/default');
    expect(data.snippets.claudeCode).toContain('https://kag.test/mcp/default');
    expect(data.snippets.claudeCode).toContain('claude mcp add --transport http');
    expect(data.snippets.claudeCode).toContain('<TWÓJ_KLUCZ>');
    expect(data.snippets.cursor).toContain('https://kag.test/mcp/default');
    expect(data.snippets.generic).toContain('<TWÓJ_KLUCZ>');
    // Żaden wygenerowany wcześniej klucz nie wycieka do snippetów.
    expect(JSON.stringify(data)).not.toMatch(/sk-[A-Za-z0-9_-]{10,}/);

    const missing = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/mcp/snippets?profileId=nie-ma',
      headers: as('viewer'),
    });
    expect(missing.statusCode).toBe(404);
  });

  it('GET /mcp/health odpytuje MCP_HEALTH_URL', async () => {
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/mcp/health', headers: as('viewer') });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.ok).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://kag-mcp.test:3001/healthz');
  });
});
