import { describe, expect, it } from 'vitest';
import {
  createDraft,
  createKb,
  getDraftOrThrow,
  promoteDraft,
  supersedeDraft,
} from '../src/db/index.js';
import { testDb, seedUser } from './helpers.js';

/**
 * repos/drafts — dwie rzeczy dołożone przy domykaniu audytu:
 *  1) GAP-03: metadane źródła (owner/license/date) zapisywane RAZEM z draftem,
 *     zamiast osobnym UPDATE-em po stronie workera intake'u;
 *  2) GAP-02 (część jawna): `supersedes` wycofuje poprzednika już przy zgłoszeniu,
 *     z wpisem w hash-chainie audytu.
 */

function kb(db: ReturnType<typeof testDb>): void {
  createKb(db, { namespace: 'LightingDocs', name: 'Oświetlenie' });
  db.prepare("UPDATE kb_registry SET status = 'active' WHERE namespace = ?").run('LightingDocs');
}

describe('createDraft — metadane źródła (GAP-03)', () => {
  it('zapisuje sourceOwner/sourceLicense/sourceDate w jednym INSERT-cie', () => {
    const db = testDb();
    const row = createDraft(db, {
      title: 'Karta katalogowa oprawy',
      content: 'Treść karty katalogowej.',
      sourceType: 'upload',
      sourceOwner: 'Dział techniczny',
      sourceLicense: 'CC-BY-4.0',
      sourceDate: '2026-05-01',
    });
    expect(row.source_owner).toBe('Dział techniczny');
    expect(row.source_license).toBe('CC-BY-4.0');
    expect(row.source_date).toBe('2026-05-01');
    // Odczyt z bazy, nie tylko z obiektu zwróconego przez repo.
    expect(getDraftOrThrow(db, row.id).source_owner).toBe('Dział techniczny');
  });

  it('bez metadanych źródła kolumny zostają NULL (kompatybilność wsteczna)', () => {
    const db = testDb();
    const row = createDraft(db, { title: 'Bez metadanych', content: 'x', sourceType: 'text' });
    expect(row.source_owner).toBeNull();
    expect(row.source_license).toBeNull();
    expect(row.source_date).toBeNull();
  });
});

describe('supersedeDraft — jawna reguła precedencji (GAP-02)', () => {
  it('nowy draft z metadata.supersedes wycofuje promowanego poprzednika + wpis audytu', () => {
    const db = testDb();
    kb(db);
    const actor = seedUser(db, 'user_reviewer');

    const older = createDraft(db, {
      title: 'Instrukcja montażu v1',
      content: 'Wersja pierwsza.',
      sourceType: 'text',
      namespace: 'LightingDocs',
    });
    promoteDraft(db, older.id, actor);
    expect(getDraftOrThrow(db, older.id).status).toBe('promoted');

    const newer = createDraft(db, {
      title: 'Instrukcja montażu v2',
      content: 'Wersja druga.',
      sourceType: 'text',
      namespace: 'LightingDocs',
      metadata: { supersedes: older.id },
    });

    expect(getDraftOrThrow(db, older.id).status).toBe('withdrawn');
    expect(getDraftOrThrow(db, newer.id).status).toBe('pending');

    const audit = db
      .prepare("SELECT action, resource_id, metadata_json FROM audit WHERE action = 'draft.supersede'")
      .all() as { action: string; resource_id: string; metadata_json: string }[];
    expect(audit).toHaveLength(1);
    expect(audit[0]?.resource_id).toBe(older.id);
    expect(JSON.parse(audit[0]!.metadata_json)).toMatchObject({ supersededBy: newer.id, rule: 'explicit' });
  });

  it('pole `supersedes` wprost ma pierwszeństwo nad metadanymi', () => {
    const db = testDb();
    kb(db);
    const actor = seedUser(db);
    const older = createDraft(db, {
      title: 'Stara notatka',
      content: 'Stara.',
      sourceType: 'text',
      namespace: 'LightingDocs',
    });
    promoteDraft(db, older.id, actor);

    createDraft(db, {
      title: 'Nowa notatka',
      content: 'Nowa.',
      sourceType: 'text',
      namespace: 'LightingDocs',
      supersedes: older.id,
      metadata: { supersedes: 'draft_nieistniejacy' },
    });
    expect(getDraftOrThrow(db, older.id).status).toBe('withdrawn');
  });

  it('nie rusza szkiców, które i tak nie trafią do grafu (pending/rejected) ani nieistniejących', () => {
    const db = testDb();
    kb(db);
    const pending = createDraft(db, {
      title: 'Czeka na recenzję',
      content: 'Treść.',
      sourceType: 'text',
      namespace: 'LightingDocs',
    });

    expect(supersedeDraft(db, pending.id, 'draft_inny')).toBeNull();
    expect(getDraftOrThrow(db, pending.id).status).toBe('pending');
    expect(supersedeDraft(db, 'draft_nie_istnieje', 'draft_inny')).toBeNull();
    // Brak zmiany stanu = brak wpisu audytu.
    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'draft.supersede'").get() as { n: number }
    ).n;
    expect(n).toBe(0);
  });

  it('draft wskazujący SAM SIEBIE nie wycofuje niczego', () => {
    const db = testDb();
    kb(db);
    const row = createDraft(db, {
      title: 'Samozastąpienie',
      content: 'Treść.',
      sourceType: 'text',
      namespace: 'LightingDocs',
    });
    expect(supersedeDraft(db, row.id, row.id)).toBeNull();
    expect(getDraftOrThrow(db, row.id).status).toBe('pending');
  });
});
