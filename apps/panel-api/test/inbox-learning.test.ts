import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createKb,
  getDraft,
  getGap,
  recordGap,
  transitionKb,
  type Db,
  type GapRow,
} from '@pomagierkb/shared/db';
import type { FastifyInstance } from 'fastify';
import { makeTestApp, as } from './admin-helpers.js';

/**
 * LUKI WIEDZY (/api/v1/learning): lista z filtrami i meta.total, statystyki,
 * ignore/resolve (przejścia repo, nielegalne → 409), start-draft → gap in_draft
 * + pending draft w Inboxie + prefill dla strony Dodaj treść, auto-resolve luki
 * przy promocji draftu powstałego z luki, RBAC (viewer nie zmutuje).
 */

let app: FastifyInstance;
let db: Db;

function seedGap(question: string, namespace: string | null = null): GapRow {
  return recordGap(db, {
    question,
    source: 'mcp',
    kbNamespace: namespace,
    answerPreview: 'niepewna odpowiedź…',
  }).row;
}

beforeAll(async () => {
  ({ app, db } = await makeTestApp());
  createKb(db, { namespace: 'ActiveDocs', name: 'Baza ActiveDocs' });
  transitionKb(db, 'ActiveDocs', 'provisioning');
  transitionKb(db, 'ActiveDocs', 'active');
});

afterAll(async () => {
  await app.close();
  db.close();
});

describe('GET /api/v1/learning/gaps + /stats', () => {
  it('lista z filtrami status/namespace i meta.total; viewer ma dostęp', async () => {
    const a = seedGap('Jak dobrać oprawę do hali?', 'ActiveDocs');
    seedGap('Jaki druk ma formularz zwrotu?');
    const c = seedGap('Ile lumenów na magazyn?', 'ActiveDocs');
    const ign = await app.inject({
      method: 'POST',
      url: `/api/v1/learning/gaps/${c.id}/ignore`,
      headers: as('operator'),
    });
    expect(ign.statusCode).toBe(200);

    const all = await app.inject({ method: 'GET', url: '/api/v1/learning/gaps', headers: as('viewer') });
    expect(all.statusCode).toBe(200);
    const allBody = all.json() as {
      ok: true;
      data: { items: { id: string }[] };
      meta: { total: number; page: number; limit: number };
    };
    expect(allBody.meta).toMatchObject({ total: 3, page: 1, limit: 50 });
    expect(allBody.data.items).toHaveLength(3);

    const open = await app.inject({
      method: 'GET',
      url: '/api/v1/learning/gaps?status=open&namespace=ActiveDocs',
      headers: as('viewer'),
    });
    const openBody = open.json() as {
      data: { items: { id: string; statusLabel: string; namespace: string }[] };
      meta: { total: number };
    };
    expect(openBody.meta.total).toBe(1);
    expect(openBody.data.items[0]!.id).toBe(a.id);
    expect(openBody.data.items[0]!.statusLabel).toBe('otwarta');

    const paged = await app.inject({
      method: 'GET',
      url: '/api/v1/learning/gaps?page=2&limit=2',
      headers: as('viewer'),
    });
    const pagedBody = paged.json() as { data: { items: unknown[] }; meta: { total: number; page: number } };
    expect(pagedBody.meta).toMatchObject({ total: 3, page: 2 });
    expect(pagedBody.data.items).toHaveLength(1);
  });

  it('stats zwraca kafle per status + sumę', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/learning/stats', headers: as('viewer') });
    expect(res.statusCode).toBe(200);
    const data = (res.json() as { data: { stats: Record<string, number>; total: number } }).data;
    expect(Object.keys(data.stats).sort()).toEqual(['ignored', 'in_draft', 'open', 'resolved']);
    expect(data.total).toBe(
      data.stats['open']! + data.stats['in_draft']! + data.stats['resolved']! + data.stats['ignored']!,
    );
    expect(data.stats['ignored']).toBeGreaterThanOrEqual(1);
  });
});

describe('ignore / resolve — przejścia repo', () => {
  it('operator: open → resolved; ponowny resolve → 409', async () => {
    const g = seedGap('Czy mamy cennik hurtowy?');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/learning/gaps/${g.id}/resolve`,
      headers: as('operator'),
    });
    expect(res.statusCode).toBe(200);
    const gap = (res.json() as { data: { gap: { status: string; statusLabel: string } } }).data.gap;
    expect(gap.status).toBe('resolved');
    expect(gap.statusLabel).toBe('rozwiązana');

    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/learning/gaps/${g.id}/resolve`,
      headers: as('operator'),
    });
    expect(again.statusCode).toBe(409);
  });

  it('nieznana luka → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/learning/gaps/gap_brak/ignore',
      headers: as('operator'),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /learning/gaps/:id/start-draft — gap → in_draft + prefill', () => {
  it('tworzy pending draft (sourceType gap) i zwraca prefill {question, suggestedNamespace}', async () => {
    const g = seedGap('Jakie kable do opraw LED 150W?', 'ActiveDocs');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/learning/gaps/${g.id}/start-draft`,
      headers: as('operator'),
    });
    expect(res.statusCode).toBe(201);
    const data = (res.json() as {
      data: {
        gap: { status: string; draftId: string };
        draftId: string;
        prefill: { question: string; suggestedNamespace: string | null };
      };
    }).data;
    expect(data.gap.status).toBe('in_draft');
    expect(data.prefill).toEqual({
      question: 'Jakie kable do opraw LED 150W?',
      suggestedNamespace: 'ActiveDocs',
    });
    expect(data.gap.draftId).toBe(data.draftId);

    const draft = getDraft(db, data.draftId)!;
    expect(draft.status).toBe('pending');
    expect(draft.source_type).toBe('gap');
    expect(draft.source_ref).toBe(g.id);
    expect(draft.namespace).toBe('ActiveDocs');

    // Luka nie jest już otwarta → drugi start-draft to 409.
    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/learning/gaps/${g.id}/start-draft`,
      headers: as('operator'),
    });
    expect(again.statusCode).toBe(409);
  });

  it('gap bez istniejącej bazy: draft bez namespace, prefill z surową sugestią', async () => {
    const g = seedGap('Pytanie bez bazy?');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/learning/gaps/${g.id}/start-draft`,
      headers: as('operator'),
    });
    expect(res.statusCode).toBe(201);
    const data = (res.json() as {
      data: { draftId: string; prefill: { suggestedNamespace: string | null } };
    }).data;
    expect(data.prefill.suggestedNamespace).toBeNull();
    expect(getDraft(db, data.draftId)!.namespace).toBeNull();
  });
});

describe('promocja draftu z luki auto-rozwiązuje lukę', () => {
  it('promote → resolvedGaps=1, gap.status=resolved', async () => {
    const g = seedGap('Jak serwisować zasilacze?', 'ActiveDocs');
    const start = await app.inject({
      method: 'POST',
      url: `/api/v1/learning/gaps/${g.id}/start-draft`,
      headers: as('operator'),
    });
    const { draftId } = (start.json() as { data: { draftId: string } }).data;

    const promote = await app.inject({
      method: 'POST',
      url: `/api/v1/drafts/${draftId}/promote`,
      headers: as('operator'),
    });
    expect(promote.statusCode).toBe(200);
    const data = (promote.json() as { data: { draft: { status: string }; resolvedGaps: number } }).data;
    expect(data.draft.status).toBe('promoted');
    expect(data.resolvedGaps).toBe(1);

    const gap = getGap(db, g.id)!;
    expect(gap.status).toBe('resolved');
    expect(gap.draft_id).toBe(draftId);
  });
});

describe('RBAC luk wiedzy', () => {
  it('viewer nie zmutuje (403), bez sesji 401', async () => {
    const g = seedGap('Pytanie RBAC?');
    for (const url of [
      `/api/v1/learning/gaps/${g.id}/ignore`,
      `/api/v1/learning/gaps/${g.id}/resolve`,
      `/api/v1/learning/gaps/${g.id}/start-draft`,
    ]) {
      const res = await app.inject({ method: 'POST', url, headers: as('viewer') });
      expect(res.statusCode, `POST ${url} dla viewera`).toBe(403);
    }
    const anon = await app.inject({ method: 'POST', url: `/api/v1/learning/gaps/${g.id}/ignore` });
    expect(anon.statusCode).toBe(401);
    expect(getGap(db, g.id)!.status).toBe('open');
  });
});
