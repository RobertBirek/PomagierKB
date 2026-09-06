import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDraft,
  getKbOrThrow,
  latestExportRun,
  promoteDraft,
  withdrawDraft,
  type Db,
  type DraftRow,
} from '@pomagierkb/shared/db';
import { AppError } from '@pomagierkb/shared/errors';
import {
  applyPrecedence,
  docIdFor,
  graphText,
  runExport,
  type ExportResult,
} from '../src/pipeline/exporter.js';
import {
  confirmTombstones,
  pendingTombstones,
  TOMBSTONE_CONTENT,
  TOMBSTONE_SEMANTIC_TYPE,
} from '../src/pipeline/graph-ids.js';
import { settleDirtyAfterBuild, snapshotDirty } from '../src/pipeline/kb-dirty.js';
import { parseCsv } from '../src/pipeline/quality-gate.js';
import { createKbEntry } from '../src/services/kb.js';
import { makeDb, makeKbTestConfig } from './helpers/kb.js';

/**
 * REGRESJE AUDYTU G3 (pipeline wiedzy i integralność danych):
 *  - D7-01: tożsamość dokumentu odporna na kolizje source_ref + twarda bramka duplikatów,
 *  - D7-02/D14-01/D14-02: propagacja wycofania do grafu (nagrobki),
 *  - D7-03/D8-02: brak literalnych nowych linii w polach indeksowanych,
 *  - D7-04: promocja W TRAKCIE builda nie ginie,
 *  - GAP-02: precedencja (supersedes / nowsza wersja tego samego źródła),
 *  - GAP-03: metadane źródła w eksporcie,
 *  - GAP-04: manifest parametrów eksportu.
 */

const dbs: Db[] = [];

function freshKb(namespace: string): { db: Db; dataDir: string } {
  const db = makeDb();
  dbs.push(db);
  createKbEntry(db, { namespace, name: `Baza ${namespace}` });
  return { db, dataDir: makeKbTestConfig().dataDir };
}

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close();
});

interface SeedOpts {
  title: string;
  content: string;
  sourceRef?: string | null;
  promote?: boolean;
}

function seed(db: Db, namespace: string, opts: SeedOpts): DraftRow {
  const draft = createDraft(db, {
    title: opts.title,
    content: opts.content,
    sourceType: 'text',
    namespace,
    sourceRef: opts.sourceRef ?? null,
    tags: ['Test'],
    analysis: { summary: 'Streszczenie.', language: 'pl' },
  });
  return opts.promote === false ? draft : promoteDraft(db, draft.id, 'u-test');
}

function records(exp: ExportResult, fileName: string): Record<string, string>[] {
  const file = exp.files.find((f) => f.fileName === fileName)!;
  const rows = parseCsv(readFileSync(file.path, 'utf8'));
  const header = rows[0]!;
  return rows.slice(1).map((r) => Object.fromEntries(header.map((c, i) => [c, r[i] ?? ''])));
}

describe('D7-01 — tożsamość dokumentu', () => {
  it('dwa RÓŻNE dokumenty o tym samym source_ref mają różne id (nie zlewają się w grafie)', () => {
    const NS = 'IdentDocs';
    const { db, dataDir } = freshKb(NS);
    const first = seed(db, NS, { title: 'Notatka', content: 'Pierwsza wersja notatki.', sourceRef: 'README.md' });
    const second = seed(db, NS, { title: 'Notatka', content: 'Zupełnie inna treść.', sourceRef: 'README.md' });
    expect(docIdFor(NS, first)).not.toBe(docIdFor(NS, second));

    const exp = runExport({ db, dataDir }, NS);
    const docs = records(exp, 'reference_document.csv').filter(
      (r) => r['semanticType'] !== TOMBSTONE_SEMANTIC_TYPE,
    );
    // Reguła precedencji zostawia w stanie docelowym wyłącznie NOWSZĄ wersję (GAP-02).
    expect(docs).toHaveLength(1);
    expect(docs[0]!['id']).toBe(docIdFor(NS, second));
    expect(exp.superseded.map((s) => s.draftId)).toEqual([first.id]);

    // Chunki obu wersji nie mogą mieć wspólnych id (to był mechanizm incydentu).
    const ids = records(exp, 'chunk.csv').map((r) => r['id']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('duplikat id (ta sama treść bez source_ref) przerywa eksport PRZED zapisem plików', () => {
    const NS = 'DupDocs';
    const { db, dataDir } = freshKb(NS);
    const content = 'Identyczna treść zgłoszona dwa razy bez źródła.';
    seed(db, NS, { title: 'Kopia A', content });
    seed(db, NS, { title: 'Kopia B', content });

    let caught: unknown;
    try {
      runExport({ db, dataDir }, NS);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('conflict');
    expect((caught as AppError).message).toContain('zdublowane id');
    // Run zamknięty błędem, mirror nietknięty — do buildera nic nie poszło.
    expect(latestExportRun(db, NS)?.status).toBe('error');
    const mirror = db.prepare('SELECT COUNT(*) AS n FROM chunks_mirror WHERE namespace = ?').get(NS) as { n: number };
    expect(mirror.n).toBe(0);
  });
});

describe('D7-02/D14-01 — propagacja wycofania do grafu (nagrobki)', () => {
  it('withdraw promowanego dokumentu → nagrobki w kolejnym eksporcie, potwierdzane po buildzie', () => {
    const NS = 'TombDocs';
    const { db, dataDir } = freshKb(NS);
    const draft = seed(db, NS, { title: 'Do wycofania', content: '# Do wycofania\n\nTreść poufna.', sourceRef: 'a.md' });
    const first = runExport({ db, dataDir }, NS);
    const oldChunkIds = records(first, 'chunk.csv').map((r) => r['id']!);
    expect(oldChunkIds.length).toBeGreaterThan(0);
    expect(first.tombstones).toHaveLength(0);

    withdrawDraft(db, draft.id, 'u-test');
    seed(db, NS, { title: 'Zastępczy', content: 'Inna treść, żeby eksport nie był pusty.', sourceRef: 'b.md' });
    const second = runExport({ db, dataDir }, NS);

    // Każde id ze starego stanu docelowego dostaje wiersz nadpisujący treść w grafie.
    expect(second.tombstones.map((t) => t.id)).toEqual(expect.arrayContaining(oldChunkIds));
    const chunkRows = records(second, 'chunk.csv');
    for (const id of oldChunkIds) {
      const row = chunkRows.find((r) => r['id'] === id)!;
      expect(row['semanticType']).toBe(TOMBSTONE_SEMANTIC_TYPE);
      expect(row['content']).toBe(TOMBSTONE_CONTENT);
      expect(row['content']).not.toContain('poufna');
      expect(row['contentHash']).toBe(createHash('sha256').update(TOMBSTONE_CONTENT, 'utf8').digest('hex'));
    }
    // Dokument też jest nadpisywany (kb_entity_get nie wyciągnie już treści).
    expect(records(second, 'reference_document.csv').some((r) => r['semanticType'] === TOMBSTONE_SEMANTIC_TYPE)).toBe(true);

    // Przed potwierdzeniem: rozjazd graf↔stan docelowy widoczny w rejestrze.
    expect(pendingTombstones(db, NS).length).toBe(second.tombstones.length);
    expect(confirmTombstones(db, NS, second.runId)).toBe(second.tombstones.length);
    expect(pendingTombstones(db, NS)).toHaveLength(0);

    // Potwierdzony nagrobek nie jest wystawiany po raz drugi.
    const third = runExport({ db, dataDir }, NS);
    expect(third.tombstones).toHaveLength(0);
  });

  it('nagrobek NIEpotwierdzony (build padł) wraca w kolejnym eksporcie', () => {
    const NS = 'TombRetryDocs';
    const { db, dataDir } = freshKb(NS);
    const draft = seed(db, NS, { title: 'Wersja 1', content: 'Treść pierwsza.', sourceRef: 'x.md' });
    runExport({ db, dataDir }, NS);
    withdrawDraft(db, draft.id, 'u-test');
    seed(db, NS, { title: 'Wersja 2', content: 'Treść druga.', sourceRef: 'y.md' });

    const failed = runExport({ db, dataDir }, NS); // build po tym eksporcie „padł" — brak confirm
    expect(failed.tombstones.length).toBeGreaterThan(0);
    const retry = runExport({ db, dataDir }, NS);
    expect(retry.tombstones.map((t) => t.id).sort()).toEqual(failed.tombstones.map((t) => t.id).sort());
  });
});

describe('D7-03/D8-02 — treść w grafie bez literalnych nowych linii', () => {
  it('pola indeksowane nie zawierają \\n, a mirror zachowuje treść kanoniczną', () => {
    const NS = 'NewlineDocs';
    const { db, dataDir } = freshKb(NS);
    const content = [
      '# Oprawa HighBay 150W',
      'Barwa światła: neutralna.',
      'Strumień świetlny: 21000 lm.',
    ].join('\n');
    seed(db, NS, { title: 'Karta produktu', content, sourceRef: 'highbay.md' });
    const exp = runExport({ db, dataDir }, NS);

    for (const fileName of ['reference_document.csv', 'chunk.csv', 'topic.csv']) {
      for (const rec of records(exp, fileName)) {
        for (const col of ['name', 'content', 'contentPreview', 'summary', 'sectionHeading']) {
          expect(rec[col] ?? '', `${fileName}.${col}`).not.toMatch(/[\r\n]/);
        }
      }
    }
    const chunk = records(exp, 'chunk.csv')[0]!;
    // Słowo z POCZĄTKU linii jest osobnym tokenem (dotąd sklejało się w 'nStrumień').
    expect(chunk['content']).toContain(' Strumień ');
    expect(chunk['contentHash']).toBe(createHash('sha256').update(chunk['content']!, 'utf8').digest('hex'));
    expect(chunk['contentLength']).toBe(String(chunk['content']!.length));

    const mirror = db
      .prepare('SELECT content FROM chunks_mirror WHERE namespace = ? LIMIT 1')
      .get(NS) as { content: string };
    expect(mirror.content).toContain('\n'); // kanoniczna treść z podziałem na linie
    expect(graphText(mirror.content)).toBe(chunk['content']);
  });
});

describe('D7-04 — dirty przeżywa promocję w trakcie builda', () => {
  it('zmiana inboxu po snapshocie zostawia dirty=1; brak zmian → dirty=0', () => {
    const NS = 'DirtyDocs';
    const { db } = freshKb(NS);
    seed(db, NS, { title: 'Pierwszy', content: 'Treść.', sourceRef: 'p.md' });
    expect(getKbOrThrow(db, NS).dirty).toBe(1);

    const snapshot = snapshotDirty(db, NS);
    // …tu leci build (minuty) — operator promuje kolejny szkic:
    seed(db, NS, { title: 'Drugi', content: 'Treść druga.', sourceRef: 'd.md' });

    const settled = settleDirtyAfterBuild(db, snapshot);
    expect(settled.cleared).toBe(false);
    expect(settled.changedDuringBuild).toBe(1);
    expect(getKbOrThrow(db, NS).dirty).toBe(1); // UI/gate uczciwie mówią „uruchom build"

    const clean = settleDirtyAfterBuild(db, snapshotDirty(db, NS));
    expect(clean.cleared).toBe(true);
    expect(getKbOrThrow(db, NS).dirty).toBe(0);
  });
});

describe('GAP-02 — precedencja i temporalność', () => {
  it('front-matter supersedes wycofuje wskazany szkic ze stanu docelowego', () => {
    const NS = 'PrecDocs';
    const { db, dataDir } = freshKb(NS);
    const old = seed(db, NS, { title: 'Runbook v1', content: 'Stara procedura.', sourceRef: 'runbook-v1' });
    runExport({ db, dataDir }, NS);

    seed(db, NS, {
      title: 'Runbook v2',
      content: `---\nkind: runbook\nsupersedes: ${old.id}\n---\n\nNowa procedura.`,
      sourceRef: 'runbook-v2',
    });
    const exp = runExport({ db, dataDir }, NS);

    const live = records(exp, 'reference_document.csv').filter((r) => r['semanticType'] !== TOMBSTONE_SEMANTIC_TYPE);
    expect(live.map((r) => r['name'])).toEqual(['Runbook v2']);
    expect(exp.superseded).toEqual([
      expect.objectContaining({ draftId: old.id, reason: 'explicit' }),
    ]);
    // Zastąpiony dokument znika też z grafu (nagrobek) i z mirroru.
    expect(exp.tombstones.map((t) => t.id)).toContain(docIdFor(NS, old));
    const mirror = db
      .prepare('SELECT COUNT(*) AS n FROM chunks_mirror WHERE namespace = ? AND doc_id = ?')
      .get(NS, docIdFor(NS, old)) as { n: number };
    expect(mirror.n).toBe(0);
  });

  it('applyPrecedence: cykl supersedes nie wycofuje żadnego dokumentu', () => {
    const NS = 'CycleDocs';
    const { db } = freshKb(NS);
    const a = seed(db, NS, { title: 'A', content: 'A', sourceRef: 'a' });
    const b = seed(db, NS, { title: 'B', content: `---\nkind: lesson\nsupersedes: ${a.id}\n---\nB`, sourceRef: 'b' });
    db.prepare('UPDATE drafts SET metadata_json = ? WHERE id = ?').run(
      JSON.stringify({ supersedes: b.id }),
      a.id,
    );
    const drafts = db.prepare('SELECT * FROM drafts WHERE namespace = ? ORDER BY id').all(NS) as DraftRow[];
    expect(applyPrecedence(drafts).kept).toHaveLength(2);
  });
});

describe('GAP-03/GAP-04 — metadane źródła i reprodukowalność', () => {
  it('front-matter owner/license/date → publishedAt i linia proweniencji w description', () => {
    const NS = 'MetaDocs';
    const { db, dataDir } = freshKb(NS);
    seed(db, NS, {
      title: 'Karta katalogowa',
      content: '---\nowner: Dział Techniczny\nlicense: CC-BY-4.0\ndate: 2026-03-01\n---\n\nTreść karty.',
      sourceRef: 'karta.md',
    });
    const doc = records(runExport({ db, dataDir }, NS), 'reference_document.csv')[0]!;
    expect(doc['publishedAt']).toBe('2026-03-01');
    expect(doc['description']).toContain('Właściciel: Dział Techniczny');
    expect(doc['description']).toContain('Licencja: CC-BY-4.0');
  });

  it('manifest eksportu zapisuje parametry, które wyprodukowały artefakty', () => {
    const NS = 'ParamDocs';
    const { db, dataDir } = freshKb(NS);
    seed(db, NS, { title: 'Dokument', content: 'Treść dokumentu.', sourceRef: 'd.md' });
    const exp = runExport({ db, dataDir }, NS, { maxLen: 900, previewLen: 300 });

    expect(exp.params.chunker).toEqual({ maxLen: 900, previewLen: 300 });
    expect(exp.params.exporterVersion).toBeGreaterThanOrEqual(2);
    expect(exp.params.docCount).toBe(1);

    const row = db.prepare('SELECT params_json FROM export_runs WHERE id = ?').get(exp.runId) as {
      params_json: string | null;
    };
    expect(JSON.parse(row.params_json!)).toMatchObject({ chunker: { maxLen: 900 } });

    const manifestPath = join(exp.dir, '_manifest.json');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: { fileName: string }[] };
    expect(manifest.files.map((f) => f.fileName)).toEqual([
      'topic.csv',
      'reference_document.csv',
      'chunk.csv',
    ]);
  });
});
