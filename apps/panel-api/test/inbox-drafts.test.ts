import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createDraft,
  createKb,
  getDraft,
  getKbOrThrow,
  rejectDraft,
  transitionKb,
  clearDirty,
  type Db,
  type DraftRow,
} from '@pomagierkb/shared/db';
import type { FastifyInstance } from 'fastify';
import { makeTestApp, as } from './admin-helpers.js';
import { DRAFT_STATUSES, GAP_STATUSES, MESSAGES } from '../src/services/messages.js';

/**
 * INBOX draftów (/api/v1/drafts): lista z filtrami i meta.total, detal,
 * edycja pending, promote (409 bez aktywnej KB, PL komunikat), reject,
 * withdraw (dirty=1), bulk dwufazowy (dryRun raport per id → apply tylko ok),
 * DELETE tylko rejected (admin), RBAC (viewer nie zmutuje).
 */

let app: FastifyInstance;
let db: Db;

/** KB w zadanym stanie ('draft' = tuż po utworzeniu, bez provisioningu). */
function seedKb(namespace: string, status: 'draft' | 'active'): void {
  createKb(db, { namespace, name: `Baza ${namespace}` });
  if (status === 'active') {
    transitionKb(db, namespace, 'provisioning');
    transitionKb(db, namespace, 'active');
  }
}

function seedDraft(title: string, namespace: string | null, content?: string): DraftRow {
  return createDraft(db, {
    title,
    content: content ?? `Treść: ${title}`,
    sourceType: 'text',
    namespace,
    analysis: { provider: 'heuristic', warnings: [] },
  });
}

beforeAll(async () => {
  ({ app, db } = await makeTestApp());
  seedKb('ActiveDocs', 'active');
  seedKb('DraftDocs', 'draft');
});

afterAll(async () => {
  await app.close();
  db.close();
});

describe('słownik komunikatów PL — statusy draftów i luk', () => {
  it.each([
    ['statusy draftów', DRAFT_STATUSES],
    ['statusy luk', GAP_STATUSES],
  ] as const)('%s: każdy status ma wpis z niepustą etykietą', (_name, codes) => {
    for (const code of codes) {
      const entry = MESSAGES[code];
      expect(entry, `brak wpisu w MESSAGES dla '${code}'`).toBeDefined();
      expect(entry!.label.length).toBeGreaterThan(0);
      expect(entry!.label).not.toBe(code);
    }
  });
});

describe('GET /api/v1/drafts — lista z filtrami i total', () => {
  it('filtry status/namespace/q + meta.total; viewer ma dostęp', async () => {
    const a = seedDraft('Oświetlenie hali', 'ActiveDocs');
    seedDraft('Notatka biurowa', null);
    const c = seedDraft('Oświetlenie magazynu', 'ActiveDocs');
    rejectDraft(db, c.id, 'u-operator', 'duplikat');

    const all = await app.inject({ method: 'GET', url: '/api/v1/drafts', headers: as('viewer') });
    expect(all.statusCode).toBe(200);
    const allBody = all.json() as { ok: true; data: { items: { id: string }[] }; meta: { total: number; page: number; limit: number } };
    expect(allBody.meta.total).toBe(3);
    expect(allBody.meta.page).toBe(1);
    expect(allBody.data.items).toHaveLength(3);
    // Widok listowy bez treści.
    expect(allBody.data.items[0]).not.toHaveProperty('contentMd');

    const pending = await app.inject({
      method: 'GET',
      url: '/api/v1/drafts?status=pending&namespace=ActiveDocs',
      headers: as('viewer'),
    });
    const pendingBody = pending.json() as { data: { items: { id: string; statusLabel: string }[] }; meta: { total: number } };
    expect(pendingBody.meta.total).toBe(1);
    expect(pendingBody.data.items[0]!.id).toBe(a.id);
    expect(pendingBody.data.items[0]!.statusLabel).toBe('czeka na recenzję');

    const q = await app.inject({ method: 'GET', url: '/api/v1/drafts?q=magazynu', headers: as('viewer') });
    expect((q.json() as { meta: { total: number } }).meta.total).toBe(1);

    const paged = await app.inject({ method: 'GET', url: '/api/v1/drafts?page=2&limit=2', headers: as('viewer') });
    const pagedBody = paged.json() as { data: { items: unknown[] }; meta: { total: number; page: number; limit: number } };
    expect(pagedBody.meta).toMatchObject({ total: 3, page: 2, limit: 2 });
    expect(pagedBody.data.items).toHaveLength(1);
  });

  it('limit > 200 odrzucany przez schemat (400)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/drafts?limit=201', headers: as('viewer') });
    expect(res.statusCode).toBe(400);
  });

  it('GET /drafts/:id — pełna treść + analysis + ludzki status; 404 dla nieznanego', async () => {
    const d = seedDraft('Detal draftu', 'ActiveDocs', 'Pełna treść w markdown.');
    const res = await app.inject({ method: 'GET', url: `/api/v1/drafts/${d.id}`, headers: as('viewer') });
    expect(res.statusCode).toBe(200);
    const draft = (res.json() as { data: { draft: Record<string, unknown> } }).data.draft;
    expect(draft['contentMd']).toBe('Pełna treść w markdown.');
    expect(draft['analysis']).toMatchObject({ provider: 'heuristic' });
    expect(draft['statusHuman']).toMatchObject({ label: 'czeka na recenzję' });

    const missing = await app.inject({ method: 'GET', url: '/api/v1/drafts/draft_brak', headers: as('viewer') });
    expect(missing.statusCode).toBe(404);
  });
});

describe('PATCH /api/v1/drafts/:id — edycja pending', () => {
  it('operator edytuje title/tags/namespace/documentCategory', async () => {
    const d = seedDraft('Do edycji', null);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/drafts/${d.id}`,
      headers: as('operator'),
      payload: { title: 'Po edycji', tags: ['lampy'], namespace: 'ActiveDocs', documentCategory: 'poradnik' },
    });
    expect(res.statusCode).toBe(200);
    const draft = (res.json() as { data: { draft: Record<string, unknown> } }).data.draft;
    expect(draft).toMatchObject({
      title: 'Po edycji',
      tags: ['lampy'],
      namespace: 'ActiveDocs',
      documentCategory: 'poradnik',
    });
  });

  it('namespace nieaktywnej bazy → 400 validation_error z komunikatem PL', async () => {
    const d = seedDraft('Zła baza', null);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/drafts/${d.id}`,
      headers: as('operator'),
      payload: { namespace: 'DraftDocs' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { ok: false; error: { code: string; message: string } };
    expect(body.error.code).toBe('validation_error');
    expect(body.error.message).toContain('nie jest aktywna');
  });

  it('draft nie-pending → 409 conflict', async () => {
    const d = seedDraft('Już odrzucony', null);
    rejectDraft(db, d.id, 'u-operator');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/drafts/${d.id}`,
      headers: as('operator'),
      payload: { title: 'Nie przejdzie' },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('promote / reject / withdraw', () => {
  it('promote wymaga KB active: baza w statusie draft → 409 z komunikatem PL', async () => {
    const d = seedDraft('Promocja do nieaktywnej', 'DraftDocs');
    const res = await app.inject({ method: 'POST', url: `/api/v1/drafts/${d.id}/promote`, headers: as('operator') });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { ok: false; error: { code: string; message: string } };
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toContain('DraftDocs');
    expect(body.error.message).toContain('nie jest aktywna');
    expect(getDraft(db, d.id)!.status).toBe('pending'); // bez mutacji
  });

  it('promote bez namespace → 409; z aktywną bazą → 200 + dirty=1; drugi promote → 409', async () => {
    const bez = seedDraft('Bez bazy', null);
    const noNs = await app.inject({ method: 'POST', url: `/api/v1/drafts/${bez.id}/promote`, headers: as('operator') });
    expect(noNs.statusCode).toBe(409);

    clearDirty(db, 'ActiveDocs');
    const d = seedDraft('Do promocji', 'ActiveDocs');
    const res = await app.inject({ method: 'POST', url: `/api/v1/drafts/${d.id}/promote`, headers: as('operator') });
    expect(res.statusCode).toBe(200);
    const data = (res.json() as { data: { draft: { status: string }; resolvedGaps: number } }).data;
    expect(data.draft.status).toBe('promoted');
    expect(data.resolvedGaps).toBe(0);
    expect(getKbOrThrow(db, 'ActiveDocs').dirty).toBe(1); // repo markDirty przy promote

    const again = await app.inject({ method: 'POST', url: `/api/v1/drafts/${d.id}/promote`, headers: as('operator') });
    expect(again.statusCode).toBe(409);
  });

  it('withdraw tylko z promoted i ustawia dirty=1', async () => {
    const d = seedDraft('Do wycofania', 'ActiveDocs');
    await app.inject({ method: 'POST', url: `/api/v1/drafts/${d.id}/promote`, headers: as('operator') });
    clearDirty(db, 'ActiveDocs');

    const res = await app.inject({ method: 'POST', url: `/api/v1/drafts/${d.id}/withdraw`, headers: as('operator') });
    expect(res.statusCode).toBe(200);
    expect(getDraft(db, d.id)!.status).toBe('withdrawn');
    expect(getKbOrThrow(db, 'ActiveDocs').dirty).toBe(1); // withdraw też brudzi KB

    const pendingOnly = seedDraft('Jeszcze pending', 'ActiveDocs');
    const bad = await app.inject({
      method: 'POST',
      url: `/api/v1/drafts/${pendingOnly.id}/withdraw`,
      headers: as('operator'),
    });
    expect(bad.statusCode).toBe(409);
  });

  it('reject z powodem zapisuje reject_reason', async () => {
    const d = seedDraft('Do odrzucenia', 'ActiveDocs');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/drafts/${d.id}/reject`,
      headers: as('operator'),
      payload: { reason: 'słaba jakość źródła' },
    });
    expect(res.statusCode).toBe(200);
    const row = getDraft(db, d.id)!;
    expect(row.status).toBe('rejected');
    expect(row.reject_reason).toBe('słaba jakość źródła');
  });
});

describe('POST /api/v1/drafts/bulk — dwufazowo', () => {
  it('dryRun raportuje konflikty per id i niczego nie zmienia; apply wykonuje tylko ok', async () => {
    const ok1 = seedDraft('Bulk ok 1', 'ActiveDocs');
    const ok2 = seedDraft('Bulk ok 2', 'ActiveDocs');
    const inDraftKb = seedDraft('Bulk nieaktywna baza', 'DraftDocs');
    const alreadyRejected = seedDraft('Bulk już odrzucony', 'ActiveDocs');
    rejectDraft(db, alreadyRejected.id, 'u-operator');
    const ids = [ok1.id, ok2.id, inDraftKb.id, alreadyRejected.id, 'draft_nie_istnieje'];

    const dry = await app.inject({
      method: 'POST',
      url: '/api/v1/drafts/bulk',
      headers: as('operator'),
      payload: { op: 'promote', ids, dryRun: true },
    });
    expect(dry.statusCode).toBe(200);
    const dryData = (dry.json() as { data: { dryRun: boolean; applied: number; results: { id: string; ok: boolean; reason?: string }[] } }).data;
    expect(dryData.dryRun).toBe(true);
    expect(dryData.applied).toBe(0);
    const byId = Object.fromEntries(dryData.results.map((r) => [r.id, r]));
    expect(byId[ok1.id]).toEqual({ id: ok1.id, ok: true });
    expect(byId[ok2.id]).toEqual({ id: ok2.id, ok: true });
    expect(byId[inDraftKb.id]!.ok).toBe(false);
    expect(byId[inDraftKb.id]!.reason).toContain('nie jest aktywna');
    expect(byId[alreadyRejected.id]!.ok).toBe(false);
    expect(byId[alreadyRejected.id]!.reason).toContain('rejected');
    expect(byId['draft_nie_istnieje']!.reason).toBe('not_found');
    // dryRun = zero mutacji.
    expect(getDraft(db, ok1.id)!.status).toBe('pending');
    expect(getDraft(db, inDraftKb.id)!.status).toBe('pending');

    const apply = await app.inject({
      method: 'POST',
      url: '/api/v1/drafts/bulk',
      headers: as('operator'),
      payload: { op: 'promote', ids },
    });
    expect(apply.statusCode).toBe(200);
    const applyData = (apply.json() as { data: { dryRun: boolean; applied: number; results: { id: string; ok: boolean }[] } }).data;
    expect(applyData.dryRun).toBe(false);
    expect(applyData.applied).toBe(2);
    expect(getDraft(db, ok1.id)!.status).toBe('promoted');
    expect(getDraft(db, ok2.id)!.status).toBe('promoted');
    expect(getDraft(db, inDraftKb.id)!.status).toBe('pending'); // konflikt nie wykonany
  });

  it('op reject działa bulk; >50 id odrzuca schemat (400)', async () => {
    const d = seedDraft('Bulk reject', null);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/drafts/bulk',
      headers: as('operator'),
      payload: { op: 'reject', ids: [d.id] },
    });
    expect((res.json() as { data: { applied: number } }).data.applied).toBe(1);
    expect(getDraft(db, d.id)!.status).toBe('rejected');

    const tooMany = await app.inject({
      method: 'POST',
      url: '/api/v1/drafts/bulk',
      headers: as('operator'),
      payload: { op: 'reject', ids: Array.from({ length: 51 }, (_, i) => `draft_${i}`) },
    });
    expect(tooMany.statusCode).toBe(400);
  });
});

describe('DELETE /api/v1/drafts/:id — admin, tylko rejected', () => {
  it('rejected znika; pending → 409; operator → 403', async () => {
    const rejected = seedDraft('Do usunięcia', null);
    rejectDraft(db, rejected.id, 'u-operator');
    const pending = seedDraft('Wciąż pending', null);

    const forbidden = await app.inject({ method: 'DELETE', url: `/api/v1/drafts/${rejected.id}`, headers: as('operator') });
    expect(forbidden.statusCode).toBe(403);

    const conflict = await app.inject({ method: 'DELETE', url: `/api/v1/drafts/${pending.id}`, headers: as('admin') });
    expect(conflict.statusCode).toBe(409);

    const res = await app.inject({ method: 'DELETE', url: `/api/v1/drafts/${rejected.id}`, headers: as('admin') });
    expect(res.statusCode).toBe(200);
    expect(getDraft(db, rejected.id)).toBeNull();
  });
});

describe('RBAC inboxu', () => {
  it('viewer nie zmutuje (403), bez sesji 401; operator tak (przekrój wyżej)', async () => {
    const d = seedDraft('RBAC test', 'ActiveDocs');
    for (const [method, url, payload] of [
      ['PATCH', `/api/v1/drafts/${d.id}`, { title: 'x' }],
      ['POST', `/api/v1/drafts/${d.id}/promote`, undefined],
      ['POST', `/api/v1/drafts/${d.id}/reject`, {}],
      ['POST', `/api/v1/drafts/${d.id}/withdraw`, undefined],
      ['POST', '/api/v1/drafts/bulk', { op: 'promote', ids: [d.id] }],
      ['DELETE', `/api/v1/drafts/${d.id}`, undefined],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: as('viewer'),
        ...(payload !== undefined ? { payload } : {}),
      });
      expect(res.statusCode, `${method} ${url} dla viewera`).toBe(403);
    }
    const anon = await app.inject({ method: 'POST', url: `/api/v1/drafts/${d.id}/promote` });
    expect(anon.statusCode).toBe(401);
    expect(getDraft(db, d.id)!.status).toBe('pending');
  });
});
