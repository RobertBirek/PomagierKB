import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDraft,
  latestExportRun,
  listExportFiles,
  promoteDraft,
  searchFts,
  type Db,
} from '@pomagierkb/shared/db';
import {
  CHUNK_COLUMNS,
  REFERENCE_DOCUMENT_COLUMNS,
  TOPIC_COLUMNS,
  csvEscape,
  docHash8,
  makeId,
  runExport,
  toCsv,
  type ExportResult,
} from '../src/pipeline/exporter.js';
import { parseCsv } from '../src/pipeline/quality-gate.js';
import { createKbEntry } from '../src/services/kb.js';
import { makeDb, makeKbTestConfig } from './helpers/kb.js';

/**
 * Eksport CSV (Etap 7): promowane drafty → 3 pliki z DOKŁADNYMI kolumnami
 * (1:1 z properties szablonu schemy + id), manifest export_runs/export_files
 * z sha256, RÓWNOLEGLE mirror chunków do FTS5 (wyszukiwalny), determinizm.
 */

const NS = 'ExportDocs';

let db: Db;
let dataDir: string;
let result: ExportResult;

const CONTENT_A = [
  '# Szynoprzewody natynkowe',
  '',
  'Szynoprzewody natynkowe trójfazowe pozwalają na elastyczny montaż opraw.',
  '',
  '## Montaż',
  '',
  'Montaż wymaga zachowania odstępów, a przewody, w tym te z przecinkami, "cudzysłowami"',
  'i nowymi liniami, muszą przejść przez escaping CSV bez strat.',
].join('\n');

const CONTENT_B = 'Oprawy awaryjne LED z własnym zasilaniem baterii — opis bez nagłówków.';

beforeAll(() => {
  db = makeDb();
  dataDir = makeKbTestConfig().dataDir;
  createKbEntry(db, { namespace: NS, name: 'Baza eksportowa' });

  const draftA = createDraft(db, {
    title: 'Szynoprzewody natynkowe — poradnik',
    content: CONTENT_A,
    sourceType: 'text',
    namespace: NS,
    sourceRef: 'https://example.test/szynoprzewody',
    tags: ['LED', 'Oświetlenie przemysłowe'],
    analysis: { summary: 'Poradnik o szynoprzewodach.', language: 'pl' },
    metadata: { sourceTier: 'official' },
  });
  const draftB = createDraft(db, {
    title: 'Oprawy awaryjne LED',
    content: CONTENT_B,
    sourceType: 'text',
    namespace: NS,
    tags: ['LED'],
  });
  promoteDraft(db, draftA.id, 'u-test');
  promoteDraft(db, draftB.id, 'u-test');

  // Draft pending NIE może trafić do eksportu.
  createDraft(db, { title: 'Szkic niezatwierdzony', content: 'Treść pending.', sourceType: 'text', namespace: NS });

  result = runExport({ db, dataDir }, NS);
});

afterAll(() => db.close());

describe('runExport', () => {
  it('produkuje 3 pliki CSV z dokładnymi kolumnami z szablonu schemy', () => {
    expect(result.files.map((f) => f.fileName)).toEqual(['topic.csv', 'reference_document.csv', 'chunk.csv']);
    const byName = new Map(result.files.map((f) => [f.fileName, f]));
    for (const [fileName, columns] of [
      ['topic.csv', TOPIC_COLUMNS],
      ['reference_document.csv', REFERENCE_DOCUMENT_COLUMNS],
      ['chunk.csv', CHUNK_COLUMNS],
    ] as const) {
      const file = byName.get(fileName)!;
      expect(file.columns).toEqual([...columns]);
      const rows = parseCsv(readFileSync(file.path, 'utf8'));
      expect(rows[0]).toEqual([...columns]); // nagłówek w pliku 1:1
      expect(rows.length - 1).toBe(file.rowCount);
    }
  });

  it('dokumenty: tylko promowane, deterministyczne id, refIds tematów, roundtrip treści przez CSV', () => {
    const file = result.files.find((f) => f.fileName === 'reference_document.csv')!;
    const rows = parseCsv(readFileSync(file.path, 'utf8'));
    const header = rows[0]!;
    const records = rows.slice(1).map((r) => Object.fromEntries(header.map((c, i) => [c, r[i] ?? ''])));
    expect(records).toHaveLength(2);
    const titles = records.map((r) => r['name']);
    expect(titles).toContain('Szynoprzewody natynkowe — poradnik');
    expect(titles).toContain('Oprawy awaryjne LED');
    expect(titles).not.toContain('Szkic niezatwierdzony');

    const docA = records.find((r) => r['name'] === 'Szynoprzewody natynkowe — poradnik')!;
    expect(docA['id']).toMatch(/^DOC_[0-9A-F]{8}_SZYNOPRZEWODY_NATYNKOWE_PORADNIK$/);
    expect(docA['semanticType']).toBe('reference_document');
    expect(docA['sourceUrl']).toBe('https://example.test/szynoprzewody');
    expect(docA['sourceTier']).toBe('official');
    expect(docA['summary']).toBe('Poradnik o szynoprzewodach.');
    expect(docA['content']).toBe(CONTENT_A); // przecinki/cudzysłowy/nowe linie przeżyły escaping RFC
    expect(docA['contentLength']).toBe(String(CONTENT_A.length));
    expect((docA['topicRefIds'] ?? '').split(',')).toContain('TOPIC_LED');
  });

  it('chunki: id CHUNK_<docHash8>_<NNN>, sourceDocumentRefId celuje w dokument, sekcje z nagłówków', () => {
    const file = result.files.find((f) => f.fileName === 'chunk.csv')!;
    const rows = parseCsv(readFileSync(file.path, 'utf8'));
    const header = rows[0]!;
    const records = rows.slice(1).map((r) => Object.fromEntries(header.map((c, i) => [c, r[i] ?? ''])));
    expect(records.length).toBeGreaterThanOrEqual(2);

    const dh8 = docHash8(NS, { source_ref: 'https://example.test/szynoprzewody', content_hash: 'x' });
    const chunkA = records.find((r) => (r['id'] ?? '').startsWith(`CHUNK_${dh8}_`));
    expect(chunkA).toBeDefined();
    expect(chunkA!['id']).toMatch(/^CHUNK_[0-9A-F]{8}_\d{3}$/);
    expect(chunkA!['semanticType']).toBe('chunk');

    const docFile = result.files.find((f) => f.fileName === 'reference_document.csv')!;
    const docRows = parseCsv(readFileSync(docFile.path, 'utf8'));
    const docIds = new Set(docRows.slice(1).map((r) => r[0]));
    for (const rec of records) {
      expect(docIds.has(rec['sourceDocumentRefId'] ?? '')).toBe(true);
    }
    expect(records.some((r) => r['sectionHeading'] === 'Montaż')).toBe(true);
  });

  it('topic.csv: agregacja tagów z usageCount = liczba dokumentów', () => {
    const file = result.files.find((f) => f.fileName === 'topic.csv')!;
    const rows = parseCsv(readFileSync(file.path, 'utf8'));
    const header = rows[0]!;
    const records = rows.slice(1).map((r) => Object.fromEntries(header.map((c, i) => [c, r[i] ?? ''])));
    const led = records.find((r) => r['id'] === 'TOPIC_LED');
    expect(led).toBeDefined();
    expect(led!['usageCount']).toBe('2'); // oba dokumenty mają tag LED
    expect(led!['semanticType']).toBe('topic');
    const industrial = records.find((r) => r['name'] === 'Oświetlenie przemysłowe');
    expect(industrial!['usageCount']).toBe('1');
  });

  it('manifest: export_run success z licznikami, export_files z poprawnym sha256', () => {
    const run = latestExportRun(db, NS);
    expect(run).not.toBeNull();
    expect(run!.id).toBe(result.runId);
    expect(run!.status).toBe('success');
    expect(run!.doc_count).toBe(2);
    expect(run!.chunk_count).toBe(result.chunkCount);

    const files = listExportFiles(db, result.runId);
    expect(files).toHaveLength(3);
    for (const f of files) {
      const onDisk = readFileSync(f.path, 'utf8');
      expect(createHash('sha256').update(onDisk, 'utf8').digest('hex')).toBe(f.sha256);
      expect(JSON.parse(f.columns_json)).toEqual(result.files.find((x) => x.fileName === f.file_name)!.columns);
    }
  });

  it('mirror FTS: chunki wyszukiwalne po polsku przez searchFts', () => {
    const hits = searchFts(db, 'szynoprzewody natynkowe', [NS]);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.docId).toMatch(/^DOC_/);
    expect(hits[0]!.id).toMatch(/^CHUNK_/);
    expect(hits[0]!.title).toBe('Szynoprzewody natynkowe — poradnik');
  });

  it('determinizm: ponowny eksport daje pliki o identycznych sha256', () => {
    const again = runExport({ db, dataDir }, NS);
    expect(again.runId).toBeGreaterThan(result.runId);
    for (const f of again.files) {
      expect(f.sha256).toBe(result.files.find((x) => x.fileName === f.fileName)!.sha256);
    }
  });
});

describe('pomocniki eksportu', () => {
  it('makeId: slug UPPERCASE bez diakrytyków; sufiks sha1 przy obcięciu', () => {
    expect(makeId('Żółta łąka nr 5')).toBe('ZOLTA_LAKA_NR_5');
    const long = 'a'.repeat(300);
    const id = makeId(long);
    expect(id.length).toBeLessThanOrEqual(106);
    expect(id).toMatch(/_[0-9A-F]{8}$/);
    // Dwa różne długie teksty o wspólnym prefiksie NIE zlewają się w jedno id.
    expect(makeId(`${long}b`)).not.toBe(id);
  });

  it('csvEscape wg RFC: podwajanie cudzysłowów, cytowanie przecinków i nowych linii', () => {
    expect(csvEscape('zwykłe')).toBe('zwykłe');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('powiedział "tak"')).toBe('"powiedział ""tak"""');
    expect(csvEscape('linia1\nlinia2')).toBe('"linia1\nlinia2"');
    const roundtrip = parseCsv(toCsv(['a', 'b'], [{ a: 'x,"\ny', b: 'z' }]));
    expect(roundtrip[1]).toEqual(['x,"\ny', 'z']);
  });
});
