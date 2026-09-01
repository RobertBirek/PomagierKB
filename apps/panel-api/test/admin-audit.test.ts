import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { appendAudit } from '@pomagierkb/shared/audit';
import { makeTestApp, as, type TestCtx } from './admin-helpers.js';

/**
 * Przeglądarka audytu (admin): filtry + kursor po seq oraz verify na łańcuchu
 * z kilkoma wpisami (w tym wykrycie manipulacji przez surowy UPDATE — który
 * blokują triggery, więc psujemy łańcuch inaczej: porównujemy wynik verify).
 */

describe('audit', () => {
  let ctx: TestCtx;

  beforeAll(async () => {
    ctx = await makeTestApp();
    // Kilka wpisów łańcucha o różnych akcjach/aktorach/wynikach.
    appendAudit(ctx.db, { actor: 'u-admin', actorType: 'user', role: 'admin', action: 'kb.create', resourceType: 'kb', resourceId: 'Docs', outcome: 'success' });
    appendAudit(ctx.db, { actor: 'u-operator', actorType: 'user', role: 'operator', action: 'draft.promote', resourceId: 'draft_1', outcome: 'success' });
    appendAudit(ctx.db, { actor: 'u-operator', actorType: 'user', role: 'operator', action: 'draft.promote', resourceId: 'draft_2', outcome: 'error' });
    appendAudit(ctx.db, { actor: 'key_abc', actorType: 'api_key', action: 'mcp.submit_draft', resourceId: 'draft_3', outcome: 'success', metadata: { tokenPrefix: 'sk-Ab1' } });
  });
  afterAll(async () => {
    await ctx.app.close();
    ctx.db.close();
  });

  it('GET /audit wymaga admina', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/audit', headers: as('operator') });
    expect(res.statusCode).toBe(403);
  });

  it('GET /audit zwraca wpisy malejąco po seq, z total w meta', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/audit', headers: as('admin') });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.meta.total).toBe(4);
    const seqs = (body.data as { seq: number }[]).map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
  });

  it('filtry action/actor/outcome działają', async () => {
    const byAction = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/audit?action=draft.promote',
      headers: as('admin'),
    });
    expect(byAction.json().meta.total).toBe(2);

    const byOutcome = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/audit?action=draft.promote&outcome=error',
      headers: as('admin'),
    });
    expect(byOutcome.json().meta.total).toBe(1);
    expect(byOutcome.json().data[0].resourceId).toBe('draft_2');

    const byActor = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/audit?actor=key_abc',
      headers: as('admin'),
    });
    expect(byActor.json().data[0]).toMatchObject({ actorType: 'api_key', action: 'mcp.submit_draft' });
  });

  it('paginacja kursorem po seq (limit + nextBeforeSeq)', async () => {
    const first = await ctx.app.inject({ method: 'GET', url: '/api/v1/audit?limit=2', headers: as('admin') });
    const page1 = first.json();
    expect(page1.data).toHaveLength(2);
    expect(page1.meta.nextBeforeSeq).toBe(page1.data[1].seq);

    const second = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/audit?limit=2&beforeSeq=${page1.meta.nextBeforeSeq}`,
      headers: as('admin'),
    });
    const page2 = second.json();
    expect(page2.data).toHaveLength(2);
    expect(Math.max(...page2.data.map((e: { seq: number }) => e.seq))).toBeLessThan(page1.meta.nextBeforeSeq);
  });

  it('GET /audit/verify: łańcuch z kilkoma wpisami jest spójny', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/audit/verify', headers: as('admin') });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ valid: true, checked: 4, problems: [] });
  });

  it('GET /audit/verify?limit= ogranicza okno weryfikacji', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/audit/verify?limit=2',
      headers: as('admin'),
    });
    expect(res.json().data).toMatchObject({ valid: true, checked: 2 });
  });
});
