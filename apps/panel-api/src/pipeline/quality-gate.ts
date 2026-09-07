import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { Db, DraftRow, ExportFileRow, QualityVerdict } from '@pomagierkb/shared/db';
import {
  listEdgesForNamespace,
  findFinishedBuildJob,
  getKb,
  latestExportRun,
  listDrafts,
  listExportFiles,
  saveQualityReport,
} from '@pomagierkb/shared/db';
import { searchText, querySpgType, type OpenSpgClient } from '@pomagierkb/shared/openspg';
import { applyPrecedence, docIdFor } from './exporter.js';
import {
  confirmedTombstones,
  pendingTombstones,
  TOMBSTONE_CONTENT,
  TOMBSTONE_SEMANTIC_TYPE,
} from './graph-ids.js';
import { readChunkingSettings } from '../services/pipeline-settings.js';
import { sha256hex } from './chunker.js';

/**
 * QUALITY GATE (Etap 9, docs/design/pipeline-frontend.md) — 14 checków na
 * OSTATNIM eksporcie KB. Każdy check: {id, level:'error'|'warn', ok, details};
 * verdict = FAIL gdy padł jakikolwiek error, WARN gdy tylko warny, inaczej OK.
 * Wynik ląduje w repo quality_reports (render w panelu; bez plików .md).
 *
 * ODSTĘPSTWO projektowe (limity pól indeksowanych): w chunk.csv indeksowane
 * TextAndVector jest PEŁNE chunk.content (limit = chunking.maxLen z ustawień,
 * domyślnie 1800), preview = chunking.previewLen (800), summary ≤400
 * — zgodnie z szablonem schemas/document_kb.schema.tpl.
 *
 * Poprawki audytu G3:
 *  - D7-08: limity NIE są zaszyte na sztywno — brane z ustawień 'chunking'
 *    (admin mógł podnieść maxLen do 8000, co dawało permanentny FAIL);
 *    promoted_coverage dopasowuje docId DOKŁADNIE, a nie po prefiksie hasha.
 *  - D7-02/D14-01: check graph_stale_nodes — czy w grafie nie zostały węzły
 *    spoza stanu docelowego (nagrobki bez potwierdzenia).
 *  - D7-03/D8-02: check no_literal_newlines — pola indeksowane bez znaków nowej
 *    linii (inaczej tokenizacja indeksu tekstowego gubi pierwsze słowo linii).
 *  - GAP-02: check superseded_documents — co wycofała reguła precedencji.
 */

export interface QualityCheckResult {
  id: string;
  level: 'error' | 'warn';
  ok: boolean;
  details: string;
}

export interface QualityGateReport {
  verdict: QualityVerdict;
  checks: QualityCheckResult[];
  runId: number | null;
}

export interface QualityGateDeps {
  db: Db;
  namespace: string;
  /** Klient OpenSPG dla live_search_sanity; null/undefined albo błąd → check pominięty (warn-poziom, ok). */
  client?: OpenSpgClient | null;
  log?: (msg: string) => void;
  limits?: { chunkContentMax?: number; previewMax?: number; summaryMax?: number };
}

// ── parser CSV (RFC 4180: cudzysłowy, przecinki i NOWE LINIE w polach) ──────

export function parseCsv(text: string): string[][] {
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
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Tabela CSV jako lista rekordów kolumna→wartość (pierwszy wiersz = nagłówek). */
function toRecords(rows: string[][]): { columns: string[]; records: Record<string, string>[] } {
  const columns = rows[0] ?? [];
  const records = rows.slice(1).map((r) => {
    const rec: Record<string, string> = {};
    columns.forEach((c, i) => {
      rec[c] = r[i] ?? '';
    });
    return rec;
  });
  return { columns, records };
}

// ── checki ──────────────────────────────────────────────────────────────────

interface LoadedFile {
  manifest: ExportFileRow;
  exists: boolean;
  shaOk: boolean;
  records: Record<string, string>[];
}

function limitList(items: string[], max = 5): string {
  return items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')} … (+${items.length - max})`;
}

/**
 * Słowo do sondy live_search_sanity: najdłuższy wyraz z WNĘTRZA treści pierwszego
 * chunka (nie pierwszy wyraz — ten był wyszukiwalny nawet przy zepsutej
 * tokenizacji). Deterministyczne: przy remisie wygrywa wcześniejsze wystąpienie.
 */
export function pickProbeWord(records: readonly Record<string, string>[]): string | undefined {
  for (const rec of records) {
    if (rec['semanticType'] === TOMBSTONE_SEMANTIC_TYPE) continue;
    const words = (rec['content'] ?? '').split(/\s+/).slice(1);
    let best: string | undefined;
    for (const raw of words) {
      const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      if (word.length < 5 || word.length > 30) continue;
      if (!/^[\p{L}][\p{L}\p{N}-]*$/u.test(word)) continue;
      if (best === undefined || word.length > best.length) best = word;
    }
    if (best !== undefined) return best;
  }
  return undefined;
}

function allPromoted(db: Db, namespace: string): DraftRow[] {
  const out: DraftRow[] = [];
  for (let offset = 0; ; offset += 200) {
    const { items, total } = listDrafts(db, { namespace, status: 'promoted', limit: 200, offset });
    out.push(...items);
    if (items.length === 0 || out.length >= total) break;
  }
  return out;
}

/**
 * Uruchamia komplet checków, zapisuje raport do quality_reports i zwraca go.
 * Brak jakiegokolwiek eksportu → natychmiastowy FAIL (bez wywracania się).
 */
export async function runQualityGate(deps: QualityGateDeps): Promise<QualityGateReport> {
  const { db, namespace } = deps;
  const log = deps.log ?? ((): void => undefined);
  // D7-08: progi MUSZĄ pochodzić z tych samych ustawień, których użył chunker
  // przy eksporcie — inaczej podniesienie maxLen w panelu = permanentny FAIL.
  const chunking = readChunkingSettings(db);
  const chunkContentMax = deps.limits?.chunkContentMax ?? chunking.maxLen;
  const previewMax = deps.limits?.previewMax ?? chunking.previewLen;
  const summaryMax = deps.limits?.summaryMax ?? 400;

  const checks: QualityCheckResult[] = [];
  const add = (id: string, level: 'error' | 'warn', ok: boolean, details: string): void => {
    checks.push({ id, level, ok, details });
    log(`quality ${id}: ${ok ? 'OK' : level.toUpperCase()} — ${details}`);
  };

  const run = latestExportRun(db, namespace);
  if (run === null) {
    add('export_files_exist', 'error', false, 'brak jakiegokolwiek eksportu dla tej bazy — uruchom build');
    const report: QualityGateReport = { verdict: 'FAIL', checks, runId: null };
    saveQualityReport(db, namespace, null, report.verdict, checks);
    return report;
  }

  // Wczytanie plików ostatniego runu (raz — kolejne checki pracują na pamięci).
  const manifests = listExportFiles(db, run.id);
  const files = new Map<string, LoadedFile>();
  for (const manifest of manifests) {
    const exists = existsSync(manifest.path);
    let shaOk = false;
    let records: Record<string, string>[] = [];
    if (exists) {
      const text = readFileSync(manifest.path, 'utf8');
      shaOk = createHash('sha256').update(text, 'utf8').digest('hex') === manifest.sha256;
      records = toRecords(parseCsv(text)).records;
    }
    files.set(manifest.file_name, { manifest, exists, shaOk, records });
  }

  // 1. export_files_exist — pliki manifestu istnieją, sha zgodne.
  {
    const bad = [...files.values()]
      .filter((f) => !f.exists || !f.shaOk)
      .map((f) => `${f.manifest.file_name}${f.exists ? ' (sha niezgodny)' : ' (brak pliku)'}`);
    add(
      'export_files_exist',
      'error',
      manifests.length > 0 && bad.length === 0,
      manifests.length === 0
        ? `run #${run.id} nie ma plików w manifescie`
        : bad.length === 0
          ? `wszystkie ${manifests.length} pliki eksportu obecne, sha zgodne`
          : `problemy z plikami: ${limitList(bad)}`,
    );
  }

  // 2. row_count_match — rowCount manifestu == liczba wierszy danych w CSV.
  {
    const bad = [...files.values()]
      .filter((f) => f.exists && f.records.length !== f.manifest.row_count)
      .map((f) => `${f.manifest.file_name}: manifest ${f.manifest.row_count} vs plik ${f.records.length}`);
    add('row_count_match', 'error', bad.length === 0,
      bad.length === 0 ? 'liczby wierszy zgodne z manifestem' : limitList(bad));
  }

  // 3. ids_unique_nonempty — kolumna id bez pustych i duplikatów (per plik).
  {
    const bad: string[] = [];
    for (const f of files.values()) {
      const seen = new Set<string>();
      for (const rec of f.records) {
        const id = rec['id'] ?? '';
        if (id === '') bad.push(`${f.manifest.file_name}: puste id`);
        else if (seen.has(id)) bad.push(`${f.manifest.file_name}: duplikat id ${id}`);
        seen.add(id);
      }
    }
    add('ids_unique_nonempty', 'error', bad.length === 0,
      bad.length === 0 ? 'id niepuste i unikalne we wszystkich plikach' : limitList(bad));
  }

  // 4. indexed_field_limits — limity pól indeksowanych + spójność hash/length.
  {
    const bad: string[] = [];
    const checkContentTriple = (file: string, rec: Record<string, string>): void => {
      const content = rec['content'] ?? '';
      if ((rec['contentPreview'] ?? '').length > previewMax) bad.push(`${file}/${rec['id']}: contentPreview > ${previewMax}`);
      if (rec['contentHash'] !== sha256hex(content)) bad.push(`${file}/${rec['id']}: contentHash niezgodny z treścią`);
      if (rec['contentLength'] !== String(content.length)) bad.push(`${file}/${rec['id']}: contentLength niezgodny z treścią`);
    };
    for (const rec of files.get('chunk.csv')?.records ?? []) {
      if ((rec['content'] ?? '').length > chunkContentMax) bad.push(`chunk.csv/${rec['id']}: content > ${chunkContentMax} (pole indeksowane!)`);
      checkContentTriple('chunk.csv', rec);
    }
    for (const rec of files.get('reference_document.csv')?.records ?? []) {
      if ((rec['summary'] ?? '').length > summaryMax) bad.push(`reference_document.csv/${rec['id']}: summary > ${summaryMax}`);
      checkContentTriple('reference_document.csv', rec);
    }
    for (const rec of files.get('topic.csv')?.records ?? []) {
      if ((rec['summary'] ?? '').length > summaryMax) bad.push(`topic.csv/${rec['id']}: summary > ${summaryMax}`);
    }
    add('indexed_field_limits', 'error', bad.length === 0,
      bad.length === 0
        ? `limity pól indeksowanych zachowane (content ≤${chunkContentMax}, preview ≤${previewMax}, summary ≤${summaryMax})`
        : limitList(bad));
  }

  // 5. referential_integrity — refIds celują w istniejące encje.
  {
    const docIds = new Set((files.get('reference_document.csv')?.records ?? []).map((r) => r['id'] ?? ''));
    const topicIds = new Set((files.get('topic.csv')?.records ?? []).map((r) => r['id'] ?? ''));
    const bad: string[] = [];
    // Nagrobki (D7-02) celowo nie mają refIds — są tylko nadpisaniem treści w grafie.
    for (const rec of files.get('chunk.csv')?.records ?? []) {
      if (rec['semanticType'] === TOMBSTONE_SEMANTIC_TYPE) continue;
      const ref = rec['sourceDocumentRefId'] ?? '';
      if (!docIds.has(ref)) bad.push(`chunk ${rec['id']}: sourceDocumentRefId ${ref || '(puste)'} nie istnieje`);
    }
    for (const rec of files.get('reference_document.csv')?.records ?? []) {
      for (const ref of (rec['topicRefIds'] ?? '').split(',').filter((s) => s !== '')) {
        if (!topicIds.has(ref)) bad.push(`dokument ${rec['id']}: topicRefId ${ref} nie istnieje`);
      }
    }
    add('referential_integrity', 'error', bad.length === 0,
      bad.length === 0 ? 'wszystkie refId celują w istniejące encje' : limitList(bad));
  }

  // 5b. graph_edges_orphans — nawigacja grafowa (kb_graph_neighbors) chodzi po tabeli
  //     `graph_edges`, którą eksport podmienia w całości per namespace. Do 2026-09-07 NIC
  //     jej nie sprawdzało: krawędź wskazująca na skasowany albo przemianowany węzeł
  //     prowadziłaby agenta do id, którego nie da się pobrać przez kb_get_source, a jedynym
  //     objawem byłoby „narzędzie zwraca puste sąsiedztwo". Tu odpowiednik
  //     `referential_integrity`, tyle że po stronie krawędzi, a nie kolumn refId.
  {
    const known = new Set<string>();
    for (const file of ['chunk.csv', 'reference_document.csv', 'topic.csv']) {
      for (const rec of files.get(file)?.records ?? []) {
        const id = rec['id'] ?? '';
        if (id !== '') known.add(id);
      }
    }
    const edges = listEdgesForNamespace(db, namespace);
    const bad: string[] = [];
    for (const edge of edges) {
      if (!known.has(edge.srcId)) bad.push(`krawędź ${edge.rel}: src ${edge.srcId} nie istnieje w eksporcie`);
      if (!known.has(edge.dstId)) bad.push(`krawędź ${edge.rel}: dst ${edge.dstId} nie istnieje w eksporcie`);
    }
    add('graph_edges_orphans', 'error', bad.length === 0,
      bad.length === 0
        ? `krawędzi ${edges.length}, wszystkie końce istnieją w eksporcie`
        : limitList(bad));
  }

  // 6. promoted_coverage — każdy promowany draft (poza wycofanymi regułą
  //    precedencji) ma ≥1 chunk. Dopasowanie DOKŁADNE po sourceDocumentRefId:
  //    prefiks hasha był ślepy na kolizje tożsamości (D7-01/D7-08).
  const promoted = allPromoted(db, namespace);
  const precedence = applyPrecedence(promoted);
  {
    const chunkDocRefs = new Set(
      (files.get('chunk.csv')?.records ?? [])
        .filter((r) => r['semanticType'] !== TOMBSTONE_SEMANTIC_TYPE)
        .map((r) => r['sourceDocumentRefId'] ?? ''),
    );
    const missing = precedence.kept
      .filter((d) => !chunkDocRefs.has(docIdFor(namespace, d)))
      .map((d) => d.title);
    add('promoted_coverage', 'error', missing.length === 0,
      missing.length === 0
        ? `każdy z ${precedence.kept.length} aktywnych promowanych draftów ma chunki w eksporcie`
        : `drafty bez chunków: ${limitList(missing)}`);
  }

  // 7. builds_finished — każdy niepusty plik ma job FINISH dla tej treści (sha).
  {
    const bad: string[] = [];
    for (const f of files.values()) {
      if (f.manifest.row_count === 0) continue;
      const done = findFinishedBuildJob(db, namespace, f.manifest.file_name, f.manifest.sha256);
      if (done === null) bad.push(f.manifest.file_name);
    }
    add('builds_finished', 'error', bad.length === 0,
      bad.length === 0 ? 'wszystkie niepuste pliki mają zakończony build' : `pliki bez zakończonego builda: ${limitList(bad)}`);
  }

  // 8. duplicate_source_urls (warn) — ten sam sourceUrl w >1 dokumencie.
  {
    const counts = new Map<string, number>();
    for (const rec of files.get('reference_document.csv')?.records ?? []) {
      const url = rec['sourceUrl'] ?? '';
      if (url !== '') counts.set(url, (counts.get(url) ?? 0) + 1);
    }
    const dups = [...counts.entries()].filter(([, n]) => n > 1).map(([url, n]) => `${url} (×${n})`);
    add('duplicate_source_urls', 'warn', dups.length === 0,
      dups.length === 0 ? 'brak zdublowanych sourceUrl' : `zdublowane sourceUrl: ${limitList(dups)}`);
  }

  // 9. live_search_sanity (warn) — search/text słowem z WNĘTRZA treści chunka
  //    (D7-03: sonda tytułem nie wykrywała, że słowa po znaku nowej linii są
  //    nieszukalne); OpenSPG niedostępny/brak klienta → check POMIJANY.
  {
    const probeWord = pickProbeWord(files.get('chunk.csv')?.records ?? []) ?? promoted[0]?.title.slice(0, 80);
    if (deps.client === undefined || deps.client === null) {
      add('live_search_sanity', 'warn', true, 'pominięto — brak klienta OpenSPG (offline)');
    } else if (probeWord === undefined || probeWord === '') {
      add('live_search_sanity', 'warn', true, 'pominięto — brak promowanych draftów do sondy');
    } else {
      try {
        const result = await searchText(deps.client, {
          projectId: getKb(deps.db, namespace)?.project_id ?? 0,
          queryString: probeWord,
          labelConstraints: [`${namespace}.Chunk`, `${namespace}.ReferenceDocument`],
          page: 1,
          topk: 5,
        });
        add('live_search_sanity', 'warn', result.items.length > 0,
          result.items.length > 0
            ? `search/text zwraca wyniki dla słowa z treści („${probeWord}")`
            : `search/text nie zwrócił wyników dla „${probeWord}" — indeks może się jeszcze budować`);
      } catch (err) {
        add('live_search_sanity', 'warn', true,
          `pominięto — OpenSPG niedostępny (${err instanceof Error ? err.message : String(err)})`);
      }
    }
  }

  // 10. dirty_flag (warn) — promocje po ostatnim buildzie.
  {
    const kb = getKb(db, namespace);
    add('dirty_flag', 'warn', kb === null || kb.dirty !== 1,
      kb === null
        ? 'baza nie istnieje w rejestrze'
        : kb.dirty === 1
          ? 'dirty=1 — są promocje po ostatnim buildzie (uruchom build ponownie)'
          : 'dirty=0 — graf zgodny ze stanem inboxu');
  }

  // 11. graph_stale_nodes (warn) — węzły, których nie ma już w stanie docelowym,
  //     a w grafie wciąż siedzą z treścią (builder jest UPSERT-only, D7-02/D14-01).
  //     Rejestr graph_ids trzyma je jako nagrobki do wystawienia; potwierdzone
  //     dopiero po udanym buildzie.
  {
    const stale = pendingTombstones(db, namespace);
    if (stale.length > 0) {
      add('graph_stale_nodes', 'warn', false,
        `węzły do wycofania z grafu: ${stale.length} (${limitList(stale.map((s) => s.id))}) — uruchom build`);
    } else {
      // Rejestr mówi „wystawione i potwierdzone", ale to za mało: przebudowa produkcji
      // 2026-09-06 pokazała, że builder OpenSPG kończy job sukcesem, a węzła NIE nadpisuje —
      // stary chunk zachował pełną treść i semanticType. Check pytający wyłącznie rejestr
      // dawał wtedy fałszywą zieleń. Pytamy więc GRAF o próbkę wycofanych id.
      const withdrawn = confirmedTombstones(db, namespace, 20);
      if (withdrawn.length === 0) {
        add('graph_stale_nodes', 'warn', true, 'brak wycofanych id — nie ma czego sprawdzać w grafie');
      } else if (deps.client === undefined || deps.client === null) {
        add('graph_stale_nodes', 'warn', true,
          `rejestr czysty (${withdrawn.length} wycofanych), ale bez klienta OpenSPG nie dało się sprawdzić grafu`);
      } else {
        try {
          const projectId = getKb(db, namespace)?.project_id ?? 0;
          const byType = new Map<string, string[]>();
          for (const w of withdrawn) {
            const spgType = `${namespace}.${w.entity}`;
            byType.set(spgType, [...(byType.get(spgType) ?? []), w.id]);
          }
          const alive: string[] = [];
          for (const [spgType, ids] of byType) {
            const found = await querySpgType(deps.client, { projectId, spgType, ids });
            for (const e of found) {
              const content = String(e.properties['content'] ?? '');
              const semantic = String(e.properties['semanticType'] ?? '');
              const isTombstone = semantic === TOMBSTONE_SEMANTIC_TYPE || content === TOMBSTONE_CONTENT;
              if (!isTombstone && content !== '') alive.push(e.id);
            }
          }
          add('graph_stale_nodes', 'warn', alive.length === 0,
            alive.length === 0
              ? `graf nie ma węzłów spoza stanu docelowego (sprawdzono ${withdrawn.length} wycofanych id)`
              : `UWAGA: ${alive.length} wycofanych węzłów NADAL ma treść w grafie (${limitList(alive)}) — ` +
                'builder UPSERT nie nadpisał nagrobka; retrieval je odsiewa po graph_ids, ale graf zachowuje treść');
        } catch (err) {
          add('graph_stale_nodes', 'warn', true,
            `nie udało się odpytać grafu o wycofane id: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  // 12. no_literal_newlines (error) — pola indeksowane bez znaków nowej linii.
  //     Builder zapisuje property jako JSON-string, więc '\n' trafiał do grafu
  //     literalnie i rozbijał tokenizację indeksu tekstowego (D7-03/D8-02).
  {
    const indexed = ['name', 'content', 'contentPreview', 'summary', 'sectionHeading'];
    const bad: string[] = [];
    for (const f of files.values()) {
      for (const rec of f.records) {
        for (const col of indexed) {
          if (/[\r\n]/.test(rec[col] ?? '')) bad.push(`${f.manifest.file_name}/${rec['id']}: ${col}`);
        }
      }
    }
    add('no_literal_newlines', 'error', bad.length === 0,
      bad.length === 0
        ? 'pola indeksowane bez znaków nowej linii (tokenizacja indeksu bezpieczna)'
        : `pola z nową linią: ${limitList(bad)}`);
  }

  // 13. superseded_documents (warn) — co wycofała reguła precedencji (GAP-02).
  {
    const list = precedence.superseded.map(
      (s) => `${s.title} (${s.reason === 'explicit' ? 'supersedes' : 'nowsza wersja tego samego źródła'})`,
    );
    add('superseded_documents', 'warn', list.length === 0,
      list.length === 0
        ? 'brak dokumentów wycofanych regułą precedencji'
        : `dokumenty zastąpione nowszą wersją (poza grafem): ${limitList(list)}`);
  }

  const verdict: QualityVerdict = checks.some((c) => !c.ok && c.level === 'error')
    ? 'FAIL'
    : checks.some((c) => !c.ok)
      ? 'WARN'
      : 'OK';
  saveQualityReport(db, namespace, run.id, verdict, checks);
  return { verdict, checks, runId: run.id };
}
