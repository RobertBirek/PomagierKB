import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  clearDirty,
  createDraft,
  getAction,
  latestQualityReport,
  promoteDraft,
  recordBuildJob,
  upsertExportFile,
  type Db,
} from '@pomagierkb/shared/db';
import { runExport, type ExportResult } from '../src/pipeline/exporter.js';
import { parseCsv, runQualityGate, type QualityGateReport } from '../src/pipeline/quality-gate.js';
import { createKbEntry } from '../src/services/kb.js';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import type { AppUser } from '../src/types.js';
import { makeDb, makeKbTestConfig, seedUser } from './helpers/kb.js';

/**
 * Quality gate (Etap 9): zdrowy eksport → OK; zdublowane id → FAIL
 * (ids_unique_nonempty); rozjazd rowCount z manifestem → FAIL (row_count_match);
 * verdict ląduje w quality_reports; trasy POST(202)/GET /kbs/:ns/quality.
 */

const NS = 'QualityDocs';

let db: Db;
let dataDir: string;
let exp: ExportResult;

function check(report: QualityGateReport, id: string): { ok: boolean; level: string; details: string } {
  const found = report.checks.find((c) => c.id === id);
  expect(found, `brak checku ${id}`).toBeDefined();
  return found!;
}

/** Nadpisuje plik eksportu i domyka manifest (sha/rowCount), żeby izolować testowany check. */
function tamperFile(runId: number, file: ExportResult['files'][number], newText: string, rowCount: number): void {
  writeFileSync(file.path, newText, 'utf8');
  upsertExportFile(db, runId, {
    fileName: file.fileName,
    rowCount,
    columns: file.columns,
    sha256: createHash('sha256').update(newText, 'utf8').digest('hex'),
    path: file.path,
  });
}

/** Wpisy build_jobs FINISH dla bieżących sha plików (jak po udanym buildzie). */
function seedFinishedBuilds(runId: number, files: ExportResult['files']): void {
  for (const f of files) {
    if (f.rowCount === 0) continue;
    recordBuildJob(db, {
      namespace: NS,
      runId,
      fileName: f.fileName,
      fileSha256: f.sha256,
      openspgJobId: 900,
      jobName: `QD ${f.fileName} import`,
      entityType: 'X',
      status: 'FINISH',
    });
  }
}

beforeAll(() => {
  db = makeDb();
  dataDir = makeKbTestConfig().dataDir;
  createKbEntry(db, { namespace: NS, name: 'Baza jakości' });
  const draft = createDraft(db, {
    title: 'Dokument jakościowy',
    content: '# Dokument jakościowy\n\nTreść testowa do kontroli jakości eksportu.',
    sourceType: 'text',
    namespace: NS,
    tags: ['Jakość'],
  });
  promoteDraft(db, draft.id, 'u-test');
  exp = runExport({ db, dataDir }, NS);
  seedFinishedBuilds(exp.runId, exp.files);
  clearDirty(db, NS); // symulacja stanu po udanym buildzie
});

afterAll(() => db.close());

describe('runQualityGate', () => {
  it('zdrowy eksport → verdict OK, 14 checków, raport zapisany w quality_reports', async () => {
    const report = await runQualityGate({ db, namespace: NS, client: null });
    expect(report.checks).toHaveLength(14);
    expect(report.verdict).toBe('OK');
    expect(report.runId).toBe(exp.runId);
    expect(check(report, 'live_search_sanity').details).toContain('pominięto'); // brak klienta OpenSPG
    // Checki dołożone audytem G3 (D7-02, D7-03/D8-02, GAP-02).
    expect(check(report, 'graph_stale_nodes').ok).toBe(true);
    expect(check(report, 'no_literal_newlines').ok).toBe(true);
    expect(check(report, 'superseded_documents').ok).toBe(true);

    const saved = latestQualityReport(db, NS);
    expect(saved?.verdict).toBe('OK');
    expect(JSON.parse(saved!.checks_json)).toHaveLength(14);
  });

  it('zdrowy eksport → krawędzie grafu bez sierot', async () => {
    const report = await runQualityGate({ db, namespace: NS, client: null });
    const c = check(report, 'graph_edges_orphans');
    expect(c.ok).toBe(true);
    expect(c.details).toContain('wszystkie końce istnieją');
  });

  it('krawędź celująca w nieistniejący węzeł → FAIL z checkiem graph_edges_orphans', async () => {
    // Scenariusz z życia: dokument zniknął z eksportu (wycofany, przemianowany), a krawędź
    // po nim została. `kb_graph_neighbors` prowadziłby wtedy agenta do id, którego nie da
    // się pobrać — objawem byłoby „narzędzie zwraca puste sąsiedztwo", bez wskazania winnego.
    const before = db
      .prepare('SELECT src_id AS srcId, rel, dst_id AS dstId FROM graph_edges WHERE namespace = ?')
      .all(NS) as { srcId: string; rel: string; dstId: string }[];
    db.prepare(
      'INSERT OR IGNORE INTO graph_edges (namespace, src_id, rel, dst_id) VALUES (?, ?, ?, ?)',
    ).run(NS, 'CHUNK_DEADBEEF_000', 'in_document', 'DOC_NIEISTNIEJACY');
    try {
      const report = await runQualityGate({ db, namespace: NS, client: null });
      const c = check(report, 'graph_edges_orphans');
      expect(c.ok).toBe(false);
      expect(c.details).toContain('DOC_NIEISTNIEJACY');
      expect(report.verdict).toBe('FAIL'); // poziom error, nie warn — nawigacja jest zepsuta
    } finally {
      db.prepare('DELETE FROM graph_edges WHERE namespace = ? AND dst_id = ?').run(
        NS,
        'DOC_NIEISTNIEJACY',
      );
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM graph_edges WHERE namespace = ?').get(NS),
      ).toEqual({ n: before.length });
    }
  });

  it('zdublowane id w chunk.csv → FAIL z checkiem ids_unique_nonempty', async () => {
    const file = exp.files.find((f) => f.fileName === 'chunk.csv')!;
    const original = readFileSync(file.path, 'utf8');
    const rows = parseCsv(original);
    // Duplikat: dopisujemy kopię ostatniego wiersza danych (poprawnie zescape'owaną — re-render z parsera).
    const dupRow = rows[rows.length - 1]!;
    const rendered = dupRow.map((v) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v)).join(',');
    const tampered = `${original}${rendered}\n`;
    try {
      tamperFile(exp.runId, file, tampered, file.rowCount + 1);
      const report = await runQualityGate({ db, namespace: NS, client: null });
      expect(report.verdict).toBe('FAIL');
      const c = check(report, 'ids_unique_nonempty');
      expect(c.ok).toBe(false);
      expect(c.details).toContain('duplikat id');
      // Manifest domknięty → sąsiednie checki plikowe nie fałszują wyniku.
      expect(check(report, 'export_files_exist').ok).toBe(true);
      expect(check(report, 'row_count_match').ok).toBe(true);
    } finally {
      tamperFile(exp.runId, file, original, file.rowCount);
    }
  });

  it('rowCount w manifescie niezgodny z plikiem → FAIL z checkiem row_count_match', async () => {
    const file = exp.files.find((f) => f.fileName === 'reference_document.csv')!;
    const original = readFileSync(file.path, 'utf8');
    try {
      tamperFile(exp.runId, file, original, file.rowCount + 5);
      const report = await runQualityGate({ db, namespace: NS, client: null });
      expect(report.verdict).toBe('FAIL');
      const c = check(report, 'row_count_match');
      expect(c.ok).toBe(false);
      expect(c.details).toContain('reference_document.csv');
    } finally {
      tamperFile(exp.runId, file, original, file.rowCount);
    }
  });

  it('dirty=1 → verdict WARN z checkiem dirty_flag (warn nie blokuje)', async () => {
    db.prepare('UPDATE kb_registry SET dirty = 1 WHERE namespace = ?').run(NS);
    try {
      const report = await runQualityGate({ db, namespace: NS, client: null });
      expect(report.verdict).toBe('WARN');
      const c = check(report, 'dirty_flag');
      expect(c.ok).toBe(false);
      expect(c.level).toBe('warn');
    } finally {
      clearDirty(db, NS);
    }
  });

  it('brak jakiegokolwiek eksportu → FAIL bez wywracania się', async () => {
    createKbEntry(db, { namespace: 'QualityEmpty', name: 'Bez eksportu' });
    const report = await runQualityGate({ db, namespace: 'QualityEmpty', client: null });
    expect(report.verdict).toBe('FAIL');
    expect(report.runId).toBeNull();
    expect(check(report, 'export_files_exist').ok).toBe(false);
  });
});

describe('trasy /kbs/:ns/quality', () => {
  let app: FastifyInstance;
  let routesDb: Db;
  let config: AppConfig;
  let operator: AppUser;

  beforeAll(async () => {
    routesDb = makeDb();
    config = makeKbTestConfig();
    operator = seedUser(routesDb, 'u-operator', 'operator');
    createKbEntry(routesDb, { namespace: 'QualityRoute', name: 'Baza tras' });
    app = await buildApp({ config, db: routesDb });
    app.addHook('onRequest', async (req) => {
      req.user = operator;
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    routesDb.close();
  });

  it('GET bez raportu → 200 {report: null}; 404 dla nieistniejącej bazy', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/kbs/QualityRoute/quality' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { report: unknown } }).data.report).toBeNull();

    const missing = await app.inject({ method: 'GET', url: '/api/v1/kbs/NoSuchKb/quality' });
    expect(missing.statusCode).toBe(404);
  });

  it('POST → 202 z actionId (spawn akcji quality_gate); GET zwraca raport po zapisie', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/kbs/QualityRoute/quality', payload: {} });
    expect(res.statusCode).toBe(202);
    const { data } = res.json() as { data: { actionId: string; type: string; resource: string } };
    expect(data.actionId).toMatch(/^act_/);
    expect(data.type).toBe('quality_gate');
    expect(data.resource).toBe('kb:QualityRoute');

    // Proces potomny w tym środowisku nie wystartuje sensownie (brak dist/env) —
    // czekamy tylko na status terminalny, żeby nie zostawić wiszącej akcji.
    const deadline = Date.now() + 8_000;
    let status = 'running';
    while (Date.now() < deadline) {
      status = getAction(routesDb, data.actionId)?.status ?? 'running';
      if (status !== 'running') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(status).not.toBe('running');

    // Raport przez trasę GET — zapis bezpośredni (kształt odpowiedzi z verdictLabel PL).
    await runQualityGate({ db: routesDb, namespace: 'QualityRoute', client: null });
    const got = await app.inject({ method: 'GET', url: '/api/v1/kbs/QualityRoute/quality' });
    expect(got.statusCode).toBe(200);
    const report = (got.json() as { data: { report: { verdict: string; verdictLabel: string; checks: unknown[] } } })
      .data.report;
    expect(report.verdict).toBe('FAIL'); // brak eksportu dla tej bazy
    expect(report.verdictLabel).not.toBe('FAIL'); // etykieta PL, nie surowy kod
    expect(report.checks.length).toBeGreaterThan(0);
  });
});

// ── parseCsv: parser na wycinkach vs referencyjny znak-po-znaku (OOM 2026-09-09) ────────────
function parseCsvReference(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

describe('parseCsv — zgodność z parserem referencyjnym i koszt pamięci', () => {
  const cases = [
    'a,b,c\n1,2,3\n',
    'a,b\r\n"x, y","z\nw"\r\n',
    '"po""dwójny",""\n',
    'bez,nowej,linii',
    'pusty,,koniec,\n',
    '"tylko"\n\n"dwa"\n',
    'a,"b"c,d\n',
    '',
    '\n',
    ',\n',
    '"otwarty,bez zamknięcia',
  ];
  it('daje identyczny wynik jak parser referencyjny na przypadkach brzegowych', () => {
    for (const c of cases) expect(parseCsv(c), JSON.stringify(c)).toEqual(parseCsvReference(c));
  });
  it('fuzz: losowe kombinacje przecinków, cudzysłowów i CR/LF', () => {
    const alphabet = ['a', 'ż', ',', '"', '\n', '\r', ' ', 'x'];
    let seed = 42;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let k = 0; k < 300; k++) {
      const len = rnd() % 40;
      let s = '';
      for (let i = 0; i < len; i++) s += alphabet[rnd() % alphabet.length];
      expect(parseCsv(s), JSON.stringify(s)).toEqual(parseCsvReference(s));
    }
  });
  it('plik 8 MB (pola z cudzysłowami i nowymi liniami) parsuje się w rozsądnym czasie', () => {
    const row = 'CHUNK_X,"' + 'treść z przecinkiem, nową linią\ni ""cudzysłowem"" '.repeat(20) + '",ok\n';
    const text = 'id,content,flag\n' + row.repeat(Math.ceil(8_000_000 / row.length));
    const t0 = Date.now();
    const rows = parseCsv(text);
    expect(rows.length).toBe(Math.ceil(8_000_000 / row.length) + 1);
    expect(rows[1]![1]).toContain('"cudzysłowem"');
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
