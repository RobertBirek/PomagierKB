import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import {
  bulkDryRun,
  createDraft,
  createKb,
  DRAFT_LIMITS,
  findByContentHash,
  getKbOrThrow,
  listDrafts,
  promoteDraft,
  rejectDraft,
  updatePending,
  withdrawDraft,
} from '../src/db/index.js';
import { sha256hex } from '../src/db/repos/util.js';
import { testDb, seedUser } from './helpers.js';

describe('repos/drafts', () => {
  it('create: id draft_<data>_<hex8>_<slug>, hash treści, walidacja limitów', () => {
    const db = testDb();
    const d = createDraft(db, {
      title: 'Montaż szynoprzewodów — instrukcja',
      content: 'Treść dokumentu o montażu.',
      sourceType: 'text',
    });
    expect(d.id).toMatch(/^draft_\d{4}-\d{2}-\d{2}_[0-9a-f]{8}_montaz-szynoprzewodow-instrukcja$/);
    expect(d.status).toBe('pending');
    expect(d.content_hash).toBe(sha256hex('Treść dokumentu o montażu.'));

    expect(() =>
      createDraft(db, { title: 'x'.repeat(301), content: 'ok', sourceType: 'text' }),
    ).toThrowError(/title/);
    expect(() =>
      createDraft(db, { title: 'T', content: 'x'.repeat(100_001), sourceType: 'text' }),
    ).toThrowError(/content/);
    expect(() =>
      createDraft(db, {
        title: 'T',
        content: 'ok',
        sourceType: 'text',
        tags: Array.from({ length: 11 }, (_, i) => `t${i}`),
      }),
    ).toThrowError(/tagów/);
  });

  it('limit per zgłaszający: klucz A wyczerpuje kwotę, klucz B i użytkownik dalej mogą', () => {
    const db = testDb();
    for (let i = 0; i < DRAFT_LIMITS.perSubmitterPerDay; i++) {
      createDraft(db, {
        title: `Agent A ${i}`,
        content: `treść ${i}`,
        sourceType: 'mcp',
        submittedByKey: 'key_A',
      });
    }
    try {
      createDraft(db, { title: 'nadmiar A', content: 'x', sourceType: 'mcp', submittedByKey: 'key_A' });
      expect.unreachable('powinno rzucić');
    } catch (err) {
      expect((err as AppError).code).toBe('rate_limited');
      expect((err as AppError).message).toContain('zgłaszającego');
    }
    // inny klucz i panelowy użytkownik nie są zagłodzeni
    expect(
      createDraft(db, { title: 'Agent B', content: 'y', sourceType: 'mcp', submittedByKey: 'key_B' }).id,
    ).toBeTruthy();
    const uid = seedUser(db, 'u1');
    expect(
      createDraft(db, { title: 'Człowiek', content: 'z', sourceType: 'text', submittedByUser: uid }).id,
    ).toBeTruthy();
  });

  it("ustawienie 'drafts.limits' nadpisuje kwotę per zgłaszający", () => {
    const db = testDb();
    db.prepare(
      "INSERT INTO settings (key, value_json, is_secret, updated_at) VALUES ('drafts.limits', ?, 0, datetime('now'))",
    ).run(JSON.stringify({ perSubmitterPerDay: 2 }));
    createDraft(db, { title: 'a', content: '1', sourceType: 'mcp', submittedByKey: 'k' });
    createDraft(db, { title: 'b', content: '2', sourceType: 'mcp', submittedByKey: 'k' });
    try {
      createDraft(db, { title: 'c', content: '3', sourceType: 'mcp', submittedByKey: 'k' });
      expect.unreachable('powinno rzucić');
    } catch (err) {
      expect((err as AppError).code).toBe('rate_limited');
    }
  });

  it('filtr tag: EXISTS po tags_json (chip Lekcje w Inboxie)', () => {
    const db = testDb();
    createDraft(db, {
      title: '[lesson] Caddy bind-mount wymaga restartu',
      content: '---\nkind: lesson\nproject: pomagierkb\n---\nTreść lekcji.',
      sourceType: 'mcp',
      tags: ['lesson', 'project:pomagierkb'],
    });
    createDraft(db, { title: 'Zwykły dokument', content: 'Treść zwykła.', sourceType: 'text' });
    const lessons = listDrafts(db, { tag: 'lesson' });
    expect(lessons.total).toBe(1);
    expect(lessons.items[0]?.title).toContain('[lesson]');
    expect(listDrafts(db, { tag: 'project:pomagierkb' }).total).toBe(1);
    expect(listDrafts(db, { tag: 'nieistniejacy' }).total).toBe(0);
  });

  it('limit dzienny: powyżej 100 draftów → rate_limited', () => {
    const db = testDb();
    for (let i = 0; i < DRAFT_LIMITS.perDay; i++) {
      createDraft(db, { title: `Draft ${i}`, content: `treść ${i}`, sourceType: 'api' });
    }
    try {
      createDraft(db, { title: 'za dużo', content: 'nadmiar', sourceType: 'api' });
      expect.unreachable('powinno rzucić');
    } catch (err) {
      expect((err as AppError).code).toBe('rate_limited');
    }
  });

  it('findByContentHash: idempotencja submitów per namespace', () => {
    const db = testDb();
    createKb(db, { namespace: 'TestKb', name: 'Testowa' });
    const d = createDraft(db, {
      title: 'Doc',
      content: 'ta sama treść',
      sourceType: 'mcp',
      namespace: 'TestKb',
    });
    expect(findByContentHash(db, 'TestKb', d.content_hash)?.id).toBe(d.id);
    expect(findByContentHash(db, null, d.content_hash)).toBeNull();
    expect(findByContentHash(db, 'TestKb', 'deadbeef')).toBeNull();
  });

  it('przejścia statusów: pending→promoted→withdrawn; nielegalne → conflict; markDirty na KB', () => {
    const db = testDb();
    seedUser(db);
    createKb(db, { namespace: 'FlowKb', name: 'Flow' });
    const d = createDraft(db, {
      title: 'Do promocji',
      content: 'treść',
      sourceType: 'text',
      namespace: 'FlowKb',
    });
    expect(getKbOrThrow(db, 'FlowKb').dirty).toBe(0);

    const promoted = promoteDraft(db, d.id, 'user_test');
    expect(promoted.status).toBe('promoted');
    expect(promoted.promoted_at).toBeTruthy();
    expect(promoted.decided_by).toBe('user_test');
    expect(getKbOrThrow(db, 'FlowKb').dirty).toBe(1);

    // promoted nie da się promować ani odrzucić
    expect(() => promoteDraft(db, d.id, 'user_test')).toThrowError(/przejście/);
    expect(() => rejectDraft(db, d.id, 'user_test')).toThrowError(/przejście/);

    // withdraw tylko z promoted
    const withdrawn = withdrawDraft(db, d.id, 'user_test');
    expect(withdrawn.status).toBe('withdrawn');
    expect(() => withdrawDraft(db, d.id, 'user_test')).toThrowError(/przejście/);

    // reject z pending + updatePending tylko dla pending
    const d2 = createDraft(db, { title: 'Do odrzucenia', content: 'inna treść', sourceType: 'text' });
    updatePending(db, d2.id, { title: 'Poprawiony tytuł', tags: ['a', 'b'] });
    const rejected = rejectDraft(db, d2.id, 'user_test', 'słaba jakość');
    expect(rejected.status).toBe('rejected');
    expect(rejected.reject_reason).toBe('słaba jakość');
    expect(() => updatePending(db, d2.id, { title: 'x' })).toThrowError(/pending/);

    // promote bez namespace → conflict
    const d3 = createDraft(db, { title: 'Bez bazy', content: 'treść 3', sourceType: 'text' });
    expect(() => promoteDraft(db, d3.id, 'user_test')).toThrowError(/namespace/);
  });

  it('list z filtrami i total; bulkDryRun raportuje per id', () => {
    const db = testDb();
    createKb(db, { namespace: 'ListKb', name: 'Lista' });
    const a = createDraft(db, { title: 'Alfa raport', content: 'a', sourceType: 'text', namespace: 'ListKb' });
    const b = createDraft(db, { title: 'Beta notatka', content: 'b', sourceType: 'text' });
    promoteDraft(db, a.id, 'u');

    expect(listDrafts(db, { status: 'pending' }).total).toBe(1);
    expect(listDrafts(db, { q: 'beta' }).items[0]?.id).toBe(b.id);
    expect(listDrafts(db, { namespace: 'ListKb' }).total).toBe(1);

    const report = bulkDryRun(db, 'promote', [a.id, b.id, 'draft_missing']);
    expect(report).toEqual([
      { id: a.id, ok: false, reason: 'conflict: status promoted' },
      { id: b.id, ok: false, reason: 'conflict: brak namespace' },
      { id: 'draft_missing', ok: false, reason: 'not_found' },
    ]);
    const c = createDraft(db, { title: 'Gamma', content: 'c', sourceType: 'text', namespace: 'ListKb' });
    expect(bulkDryRun(db, 'promote', [c.id])).toEqual([{ id: c.id, ok: true }]);
  });
});
