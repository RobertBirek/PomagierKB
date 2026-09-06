import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db, DraftRow } from '@pomagierkb/shared/db';
import {
  draftTags,
  finishExportRun,
  getKb,
  listDrafts,
  replaceForDocument,
  replaceEdgesForNamespace,
  type GraphEdge,
  startExportRun,
  upsertExportFile,
  type ChunkInput,
} from '@pomagierkb/shared/db';
import { AppError } from '@pomagierkb/shared/errors';
import { chunkDocument, makePreview, sha256hex, type DocumentChunk } from './chunker.js';
import { parseSourceFrontmatter } from './frontmatter.js';
import {
  syncGraphIds,
  TOMBSTONE_CONTENT,
  TOMBSTONE_SEMANTIC_TYPE,
  type GraphEntity,
  type GraphIdRef,
} from './graph-ids.js';

/**
 * EKSPORT CSV (Etap 7, docs/design/pipeline-frontend.md): źródło = WSZYSTKIE
 * drafty `promoted` danej KB (pełny rebuild stanu docelowego — id deterministyczne,
 * więc UPSERT w OpenSPG jest idempotentny). Pliki do DATA_DIR/exports/<ns>/<runId>/,
 * kolumny DOKŁADNIE 1:1 z properties szablonu schemas/document_kb.schema.tpl (+ id).
 * ODSTĘPSTWO projektowe: chunk.content jedzie w PEŁNEJ treści (≤1800 zn. z chunkera;
 * to ONO jest indeksowane TextAndVector — patrz szablon schemy).
 * Równolegle: mirror chunków do SQLite FTS5 (repo chunksMirror) + manifesty
 * export_runs/export_files (sha256) — resume buildu bez plików JSON.
 *
 * Poprawki audytu G3:
 *  - D7-01: tożsamość dokumentu = sha1(ns|source_ref|content_hash)[:16] — dwa RÓŻNE
 *    dokumenty o tym samym source_ref/tytule nie zlewają się już w jeden węzeł;
 *    duplikaty id są wykrywane PRZED zapisem plików (eksport przerywany).
 *  - D7-03/D8-02: wartości CSV są normalizowane (nowe linie → spacja), bo builder
 *    zapisuje property jako JSON-string i literalne `\n` rozbijają tokenizację
 *    indeksu tekstowego. Mirror FTS zachowuje treść ORYGINALNĄ.
 *  - D7-02/D14-01/D14-02: id, które wypadły ze stanu docelowego, dostają wiersz
 *    NAGROBKA (tombstone) — UPSERT nadpisuje treść i wektory w grafie.
 *  - GAP-02: precedencja — dokument zastępujący (front-matter `supersedes` albo
 *    ten sam source_ref) wycofuje poprzedni ze stanu docelowego.
 *  - GAP-04: parametry, które wyprodukowały artefakty, lądują w export_runs.params_json
 *    i w pliku _manifest.json obok CSV (reprodukowalność ingestu).
 */

/** Wersja formatu eksportu — zmiana = pełny re-build (id/normalizacja się zmieniły). */
export const EXPORTER_VERSION = 2;

// ── kolumny CSV: 1:1 z properties szablonu schemy (+ id jako pierwsza) ──────

export const TOPIC_COLUMNS = [
  'id', 'name', 'description', 'semanticType', 'topicSlug', 'usageCount', 'summary',
] as const;

export const REFERENCE_DOCUMENT_COLUMNS = [
  'id', 'name', 'description', 'semanticType', 'sourceUrl', 'sourceType', 'documentCategory',
  'language', 'sourceTier', 'publishedAt', 'retrievedAt', 'topicRefIds', 'conceptRefIds',
  'content', 'contentPreview', 'contentHash', 'contentLength', 'summary',
] as const;

export const CHUNK_COLUMNS = [
  'id', 'name', 'description', 'semanticType', 'sourceDocumentRefId', 'sourceUrl',
  'sectionHeading', 'sectionOrder', 'content', 'contentPreview', 'contentHash', 'contentLength',
] as const;

/** Kolejność buildu: refIds muszą celować w encje, które już istnieją. */
export const EXPORT_FILE_ORDER = ['topic.csv', 'reference_document.csv', 'chunk.csv'] as const;
export type ExportFileName = (typeof EXPORT_FILE_ORDER)[number];

export const ENTITY_BY_FILE: Record<ExportFileName, GraphEntity> = {
  'topic.csv': 'Topic',
  'reference_document.csv': 'ReferenceDocument',
  'chunk.csv': 'Chunk',
};

export const FILE_BY_ENTITY: Record<GraphEntity, ExportFileName> = {
  Topic: 'topic.csv',
  ReferenceDocument: 'reference_document.csv',
  Chunk: 'chunk.csv',
};

export const COLUMNS_BY_FILE: Record<ExportFileName, readonly string[]> = {
  'topic.csv': TOPIC_COLUMNS,
  'reference_document.csv': REFERENCE_DOCUMENT_COLUMNS,
  'chunk.csv': CHUNK_COLUMNS,
};

// ── pomocniki id / csv (czyste; makeId nie istnieje w shared repos/util) ────

export function sha1hex(input: string): string {
  return createHash('sha1').update(input, 'utf8').digest('hex');
}

/**
 * makeId: slug UPPERCASE (bez diakrytyków, [^A-Z0-9] → '_') przycięty do maxLen
 * (domyślnie 106); przy obcięciu doklejany sufiks _SHA1[:8] oryginału, żeby dwa
 * długie tytuły różniące się końcówką nie zlały się w jedno id.
 */
export function makeId(text: string, maxLen = 106): string {
  const slug = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replaceAll('ł', 'l')
    .replaceAll('Ł', 'L')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const safe = slug === '' ? 'X' : slug;
  if (safe.length <= maxLen) return safe;
  const suffix = `_${sha1hex(text).slice(0, 8).toUpperCase()}`;
  return safe.slice(0, Math.max(1, maxLen - suffix.length)) + suffix;
}

/**
 * Długość hasha tożsamości dokumentu. 8 znaków (32 bity) dawało ~1% szans na
 * przypadkową kolizję już przy 10 tys. dokumentów (D7-01); 16 znaków (64 bity)
 * sprowadza to do poziomu nieistotnego.
 */
export const DOC_HASH_LEN = 16;

type DocIdentity = Pick<DraftRow, 'source_ref' | 'content_hash'>;

/**
 * Stabilny hash tożsamości dokumentu: sha1(ns | source_ref | content_hash).
 *
 * D7-01: sam source_ref NIE jest tożsamością — dla wpisu tekstowego to tytuł od
 * użytkownika, dla uploadu nazwa pliku, dla MCP dowolny string od agenta. Dwa różne
 * dokumenty o tej samej nazwie dostawały identyczne id chunków i zlewały się
 * w grafie w jeden węzeł (incydent produkcyjny 2026-09-02). Dokładając content_hash
 * dostajemy tożsamość WERSJI dokumentu: edycja treści tworzy nowe id, a stare jest
 * sprzątane nagrobkiem (graph-ids.ts), więc UPSERT-only buildera nie zostawia sierot.
 */
export function docHash(namespace: string, draft: DocIdentity): string {
  const ref = draft.source_ref ?? '';
  return sha1hex(`${namespace}\u0000${ref}\u0000${draft.content_hash}`)
    .slice(0, DOC_HASH_LEN)
    .toUpperCase();
}

/**
 * Id dokumentu NIE zawiera tytułu (D14-02: poprawka tytułu tworzyła nowy węzeł,
 * a stary zostawał w grafie). Tytuł żyje wyłącznie w property `name`.
 */
export function docIdFor(namespace: string, draft: DocIdentity): string {
  return `DOC_${docHash(namespace, draft)}`;
}

export function chunkIdFor(dh: string, order: number): string {
  return `CHUNK_${dh}_${String(order).padStart(3, '0')}`;
}

export function topicIdFor(tag: string): string {
  return `TOPIC_${makeId(tag)}`;
}

/**
 * Normalizacja wartości wysyłanej do GRAFU (D7-03/D8-02): builder OpenSPG zapisuje
 * property jako zserializowany JSON, więc znak nowej linii ląduje w Neo4j jako
 * dwuznak `\n`. Analizator tekstowy sklejał wtedy 'n' z pierwszym słowem linii
 * ('nstrumień'), przez co każde słowo rozpoczynające linię było NIEWYSZUKIWALNE
 * w kanale search/text, a snippety MCP niosły literalne `\n`.
 * Kanoniczna, pełna treść (z podziałem na linie) zostaje w mirrorze FTS.
 */
export function graphText(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
}

/** Escape pola CSV wg RFC 4180 (cudzysłowy podwajane; cytowanie gdy separator/quote/nowa linia). */
export function csvEscape(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Rendetuje plik CSV: nagłówek + wiersze (kolumny w zadanej kolejności), LF, trailing newline. */
export function toCsv(columns: readonly string[], rows: Record<string, string>[]): string {
  const lines = [columns.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(row[c] ?? '')).join(','));
  }
  return `${lines.join('\n')}\n`;
}

// ── budowa wierszy (czysta logika na draftach) ──────────────────────────────

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Kolumna drafts dodana migracją 0027 (typ DraftRow w shared jeszcze jej nie zna). */
function draftColumn(draft: DraftRow, column: string): string {
  const value = (draft as unknown as Record<string, unknown>)[column];
  return typeof value === 'string' ? value : '';
}

export interface DraftSourceMeta {
  owner: string;
  license: string;
  /** Data SAMEGO dokumentu (YYYY-MM-DD) — nie data wpisu w systemie. */
  date: string;
}

/**
 * Metadane źródła (GAP-03): kolumny drafts (migracja 0027) → metadata_json →
 * front-matter treści. Pierwsze niepuste wygrywa.
 */
export function draftSourceMeta(draft: DraftRow): DraftSourceMeta {
  const metadata = parseJson<Record<string, unknown>>(draft.metadata_json, {});
  const fm = parseSourceFrontmatter(draft.content_md);
  const pick = (column: string, metaKey: string, fmValue: string | null): string =>
    draftColumn(draft, column) || str(metadata[metaKey]) || (fmValue ?? '');
  return {
    owner: pick('source_owner', 'sourceOwner', fm.owner),
    license: pick('source_license', 'sourceLicense', fm.license),
    date: pick('source_date', 'sourceDate', fm.date) || str(metadata['publishedAt']),
  };
}

/**
 * Właściciel i licencja nie mają jeszcze własnych properties w szablonie schemy
 * (zmiana schematu wymaga re-synchronizacji projektu OpenSPG — patrz raport G3),
 * więc jadą w wolnym, NIEINDEKSOWANYM polu `description` jako czytelna linia
 * proweniencji. Data dokumentu ma już swoje miejsce: `publishedAt`.
 */
export function provenanceDescription(meta: DraftSourceMeta): string {
  const parts: string[] = [];
  if (meta.owner !== '') parts.push(`Właściciel: ${meta.owner}`);
  if (meta.license !== '') parts.push(`Licencja: ${meta.license}`);
  return graphText(parts.join(' · '));
}

/** Nazwa chunka: «tytuł doc» — «heading|fragment» #N (≤180). */
function chunkName(title: string, chunk: DocumentChunk): string {
  const fragment = chunk.sectionHeading !== ''
    ? chunk.sectionHeading
    : makePreview(chunk.content.replace(/\s+/g, ' '), 60);
  return `${title} — ${fragment} #${chunk.sectionOrder + 1}`.slice(0, 180);
}

// ── precedencja i temporalność (GAP-02) ─────────────────────────────────────

export interface SupersededDraft {
  draftId: string;
  title: string;
  /** 'explicit' = front-matter `supersedes`; 'source_ref' = nowsza wersja tego samego źródła. */
  reason: 'explicit' | 'source_ref';
  /** Id draftu, który go zastępuje. */
  by: string;
}

export interface PrecedenceResult {
  kept: DraftRow[];
  superseded: SupersededDraft[];
}

function effectiveAt(draft: DraftRow): string {
  return draft.promoted_at ?? draft.created_at;
}

/** Nowszy = późniejszy promoted_at/created_at; remis rozstrzyga id (determinizm). */
function isNewer(a: DraftRow, b: DraftRow): boolean {
  const ta = effectiveAt(a);
  const tb = effectiveAt(b);
  return ta === tb ? a.id > b.id : ta > tb;
}

function supersedesTargetOf(draft: DraftRow): string | null {
  const metadata = parseJson<Record<string, unknown>>(draft.metadata_json, {});
  const fromMeta = str(metadata['supersedes']);
  if (fromMeta !== '') return fromMeta;
  return parseSourceFrontmatter(draft.content_md).supersedes;
}

/**
 * Reguła precedencji (GAP-02): dokument zastępujący WYCOFUJE poprzedni ze stanu
 * docelowego. Dwa źródła reguły:
 *  1) jawne `supersedes: <draftId>` we front-matterze albo w metadanych,
 *  2) niejawne: ten sam `source_ref` w tej samej bazie = kolejna wersja tego samego
 *     dokumentu — wygrywa NAJNOWSZY (to dokładnie scenariusz incydentu D7-01,
 *     gdzie dwa promowane szkice tego samego pliku zlały się w grafie).
 * Wycofany dokument znika z eksportu i mirroru, a w grafie dostaje nagrobek.
 */
export function applyPrecedence(drafts: readonly DraftRow[]): PrecedenceResult {
  const byId = new Map(drafts.map((d) => [d.id, d]));
  const supersededBy = new Map<string, SupersededDraft>();

  for (const draft of drafts) {
    const target = supersedesTargetOf(draft);
    if (target === null || target === draft.id) continue;
    const victim = byId.get(target);
    if (victim === undefined) continue;
    // Cykl (A zastępuje B, B zastępuje A) → nie wycofujemy nikogo jawnie.
    if (supersedesTargetOf(victim) === draft.id) continue;
    supersededBy.set(victim.id, { draftId: victim.id, title: victim.title, reason: 'explicit', by: draft.id });
  }

  const winnerBySource = new Map<string, DraftRow>();
  for (const draft of drafts) {
    if (supersededBy.has(draft.id)) continue;
    const ref = (draft.source_ref ?? '').trim();
    if (ref === '') continue;
    const prev = winnerBySource.get(ref);
    if (prev === undefined) {
      winnerBySource.set(ref, draft);
      continue;
    }
    const newer = isNewer(draft, prev) ? draft : prev;
    const older = newer === draft ? prev : draft;
    winnerBySource.set(ref, newer);
    supersededBy.set(older.id, { draftId: older.id, title: older.title, reason: 'source_ref', by: newer.id });
  }

  return {
    kept: drafts.filter((d) => !supersededBy.has(d.id)),
    superseded: [...supersededBy.values()].sort((a, b) => (a.draftId < b.draftId ? -1 : 1)),
  };
}

// ── wiersze eksportu ────────────────────────────────────────────────────────

export interface ExportRows {
  topics: Record<string, string>[];
  documents: Record<string, string>[];
  chunks: Record<string, string>[];
  /** Wejście mirroru FTS per dokument (docId → chunki) — treść ORYGINALNA. */
  mirror: { docId: string; title: string; sourceRef: string | null; chunks: ChunkInput[] }[];
  /** Krawędzie grafu (chunk→doc, doc→topic) — graph_edges w SQLite (Neo4j bez krawędzi). */
  edges: GraphEdge[];
  /** Dokumenty wycofane regułą precedencji (GAP-02) — do logu i quality gate. */
  superseded: SupersededDraft[];
}

/** Buduje wiersze wszystkich trzech plików z promowanych draftów (bez IO). */
export function buildExportRows(
  namespace: string,
  drafts: readonly DraftRow[],
  opts: { maxLen?: number; previewLen?: number } = {},
): ExportRows {
  const topics = new Map<string, { name: string; slug: string; docCount: number }>();
  const documents: Record<string, string>[] = [];
  const chunkRows: Record<string, string>[] = [];
  const mirror: ExportRows['mirror'] = [];
  const edges: GraphEdge[] = [];
  const { kept, superseded } = applyPrecedence(drafts);

  for (const draft of kept) {
    const analysis = parseJson<Record<string, unknown>>(draft.analysis_json, {});
    const metadata = parseJson<Record<string, unknown>>(draft.metadata_json, {});
    const tags = draftTags(draft);
    const dh = docHash(namespace, draft);
    const docId = docIdFor(namespace, draft);
    const sourceUrl = graphText(draft.source_ref ?? '');
    const summary = graphText(makePreview(str(analysis['summary']), 400));
    const sourceMeta = draftSourceMeta(draft);
    const docContent = graphText(draft.content_md);
    const topicIds: string[] = [];

    for (const tag of tags) {
      const id = topicIdFor(tag);
      const entry = topics.get(id);
      if (entry === undefined) {
        topics.set(id, { name: tag, slug: makeId(tag).toLowerCase().replaceAll('_', '-'), docCount: 1 });
      } else {
        entry.docCount += 1;
      }
      if (!topicIds.includes(id)) topicIds.push(id);
    }

    documents.push({
      id: docId,
      name: graphText(draft.title),
      description: provenanceDescription(sourceMeta),
      semanticType: 'reference_document',
      sourceUrl,
      sourceType: draft.source_type,
      documentCategory: draft.document_category ?? '',
      language: str(analysis['language']) || str(metadata['language']) || 'pl',
      sourceTier: str(metadata['sourceTier']),
      publishedAt: sourceMeta.date,
      retrievedAt: draft.created_at,
      topicRefIds: topicIds.join(','),
      conceptRefIds: '', // v1 bez concept.csv (sekcja b projektu)
      // contentHash/contentLength liczone z WYEKSPORTOWANEJ wartości — tylko wtedy
      // są kontrolą integralności po stronie grafu (D7-03).
      content: docContent,
      // previewLen z ustawień (gate porównuje z tym samym progiem — D7-08).
      contentPreview: makePreview(docContent, opts.previewLen),
      contentHash: sha256hex(docContent),
      contentLength: String(docContent.length),
      summary,
    });

    const docChunks = chunkDocument(draft.content_md, opts);
    const mirrorChunks: ChunkInput[] = [];
    for (const chunk of docChunks) {
      const chunkId = chunkIdFor(dh, chunk.sectionOrder);
      const chunkContent = graphText(chunk.content);
      chunkRows.push({
        id: chunkId,
        name: graphText(chunkName(draft.title, chunk)),
        description: '',
        semanticType: 'chunk',
        sourceDocumentRefId: docId,
        sourceUrl,
        sectionHeading: graphText(chunk.sectionHeading),
        sectionOrder: String(chunk.sectionOrder),
        content: chunkContent,
        contentPreview: makePreview(chunkContent, opts.previewLen),
        contentHash: sha256hex(chunkContent),
        contentLength: String(chunkContent.length),
      });
      mirrorChunks.push({
        id: chunkId,
        title: draft.title,
        sectionHeading: chunk.sectionHeading === '' ? null : chunk.sectionHeading,
        content: chunk.content, // mirror = treść kanoniczna, z podziałem na linie
        sourceRef: draft.source_ref,
      });
    }
    mirror.push({ docId, title: draft.title, sourceRef: draft.source_ref, chunks: mirrorChunks });
    for (const chunk of mirrorChunks) edges.push({ srcId: chunk.id, rel: 'in_document', dstId: docId });
    for (const topicId of topicIds) edges.push({ srcId: docId, rel: 'about_topic', dstId: topicId });
  }

  const topicRows = [...topics.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, t]) => ({
      id,
      name: t.name,
      description: '',
      semanticType: 'topic',
      topicSlug: t.slug,
      usageCount: String(t.docCount),
      summary: '',
    }));

  return { topics: topicRows, documents, chunks: chunkRows, mirror, edges, superseded };
}

/** Id wszystkich encji stanu docelowego (wejście rejestru graph_ids). */
export function graphIdsOf(rows: ExportRows): GraphIdRef[] {
  return [
    ...rows.topics.map((r) => ({ id: r['id'] ?? '', entity: 'Topic' as GraphEntity })),
    ...rows.documents.map((r) => ({ id: r['id'] ?? '', entity: 'ReferenceDocument' as GraphEntity })),
    ...rows.chunks.map((r) => ({ id: r['id'] ?? '', entity: 'Chunk' as GraphEntity })),
  ];
}

/**
 * Wiersz-nagrobek: UPSERT nadpisuje w grafie treść i wektory encji, której nie ma
 * już w stanie docelowym. Wszystkie pola puste poza id, markerem treści
 * i semanticType='tombstone' (retrieval/kontrole mogą po nim filtrować).
 */
export function tombstoneRow(entity: GraphEntity, id: string): Record<string, string> {
  const base: Record<string, string> = { id, name: '', description: '', semanticType: TOMBSTONE_SEMANTIC_TYPE };
  if (entity === 'Topic') {
    return { ...base, topicSlug: '', usageCount: '0', summary: '' };
  }
  const content = TOMBSTONE_CONTENT;
  const contentTriple = {
    content,
    contentPreview: '',
    contentHash: sha256hex(content),
    contentLength: String(content.length),
  };
  if (entity === 'ReferenceDocument') {
    return {
      ...base,
      sourceUrl: '', sourceType: '', documentCategory: '', language: '', sourceTier: '',
      publishedAt: '', retrievedAt: '', topicRefIds: '', conceptRefIds: '', summary: '',
      ...contentTriple,
    };
  }
  return {
    ...base,
    sourceDocumentRefId: '', sourceUrl: '', sectionHeading: '', sectionOrder: '0',
    ...contentTriple,
  };
}

/** Duplikaty id w obrębie pliku — wykrywane PRZED zapisem (D7-01, D7-08). */
export function findDuplicateIds(rows: readonly Record<string, string>[]): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const row of rows) {
    const id = row['id'] ?? '';
    if (id === '') {
      dups.add('(puste id)');
      continue;
    }
    if (seen.has(id)) dups.add(id);
    seen.add(id);
  }
  return [...dups];
}

// ── runExport: pliki + manifesty + mirror ───────────────────────────────────

export interface ExportedFile {
  fileName: ExportFileName;
  path: string;
  rowCount: number;
  columns: string[];
  sha256: string;
}

/** Migawka parametrów, które wyprodukowały artefakty (GAP-04 — reprodukowalność). */
export interface ExportParams {
  exporterVersion: number;
  chunker: { maxLen: number | null; previewLen: number | null };
  codeCommit: string | null;
  embeddingModel: string | null;
  vectorModelId: string | null;
  extractProviders: string[];
  analyzeProviders: string[];
  cleanProfiles: string[];
  aiCleanUsed: boolean;
  docCount: number;
  chunkCount: number;
  tombstoneCount: number;
  supersededCount: number;
  exportedAt: string;
}

export interface ExportResult {
  runId: number;
  dir: string;
  files: ExportedFile[];
  docCount: number;
  chunkCount: number;
  /** Nagrobki wystawione w tym eksporcie (do potwierdzenia po udanym buildzie). */
  tombstones: GraphIdRef[];
  superseded: SupersededDraft[];
  params: ExportParams;
}

/** Wszystkie promowane drafty KB (paginacja repo ma cap 200) w deterministycznej kolejności. */
function allPromotedDrafts(db: Db, namespace: string): DraftRow[] {
  const out: DraftRow[] = [];
  const pageSize = 200;
  for (let offset = 0; ; offset += pageSize) {
    const { items, total } = listDrafts(db, { namespace, status: 'promoted', limit: pageSize, offset });
    out.push(...items);
    if (items.length === 0 || out.length >= total) break;
  }
  return out.sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1));
}

function distinct(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && v !== ''))].sort();
}

function collectParams(
  db: Db,
  namespace: string,
  drafts: readonly DraftRow[],
  opts: { maxLen?: number; previewLen?: number },
  counts: { docCount: number; chunkCount: number; tombstoneCount: number; supersededCount: number },
): ExportParams {
  const kb = getKb(db, namespace);
  const metas = drafts.map((d) => parseJson<Record<string, unknown>>(d.metadata_json, {}));
  const analyses = drafts.map((d) => parseJson<Record<string, unknown>>(d.analysis_json, {}));
  return {
    exporterVersion: EXPORTER_VERSION,
    chunker: { maxLen: opts.maxLen ?? null, previewLen: opts.previewLen ?? null },
    // SHA obrazu/commitu wstrzykiwane przy budowie obrazu (etykieta OCI → env).
    codeCommit: process.env['APP_COMMIT'] ?? process.env['GIT_SHA'] ?? null,
    embeddingModel: kb?.embedding_model ?? null,
    vectorModelId: kb?.vector_model_id ?? null,
    extractProviders: distinct(metas.map((m) => str(m['extractProvider']))),
    analyzeProviders: distinct(analyses.map((a) => str(a['provider']))),
    cleanProfiles: distinct(metas.map((m) => str(m['cleanProfile']))),
    aiCleanUsed: analyses.some((a) => a['aiCleanUsed'] === true),
    ...counts,
    exportedAt: new Date().toISOString(),
  };
}

/**
 * Eksport KB: promowane drafty → 3 pliki CSV w DATA_DIR/exports/<ns>/<runId>/
 * + manifest (export_runs/export_files z sha256) + mirror FTS5. Błąd w trakcie
 * → run zamknięty statusem 'error' i wyjątek idzie dalej.
 *
 * Kolejność ma znaczenie: duplikaty id przerywają eksport PRZED zapisem plików
 * i przed dotknięciem mirroru — do buildera nie trafi nic, czego nie da się
 * potem rozróżnić w grafie (D7-01).
 */
export function runExport(
  deps: { db: Db; dataDir: string },
  namespace: string,
  opts: { maxLen?: number; previewLen?: number } = {},
): ExportResult {
  const { db, dataDir } = deps;
  const run = startExportRun(db, namespace);
  try {
    const drafts = allPromotedDrafts(db, namespace);
    const rows = buildExportRows(namespace, drafts, opts);

    const byFile: Record<ExportFileName, Record<string, string>[]> = {
      'topic.csv': rows.topics,
      'reference_document.csv': rows.documents,
      'chunk.csv': rows.chunks,
    };

    // 1) Twarda bramka tożsamości — PRZED plikami, mirrorem i buildem.
    for (const fileName of EXPORT_FILE_ORDER) {
      const dups = findDuplicateIds(byFile[fileName]);
      if (dups.length > 0) {
        throw new AppError(
          'conflict',
          `eksport przerwany: zdublowane id w ${fileName} (${dups.slice(0, 5).join(', ')}) — ` +
            'dwa dokumenty walczą o tę samą tożsamość; wycofaj jeden ze szkiców',
          { fileName, duplicates: dups.slice(0, 20) },
        );
      }
    }

    // 2) Rejestr id w grafie + nagrobki dla tego, co wypadło ze stanu docelowego.
    const tombstones = syncGraphIds(db, namespace, run.id, graphIdsOf(rows));
    for (const ref of tombstones) {
      byFile[FILE_BY_ENTITY[ref.entity]].push(tombstoneRow(ref.entity, ref.id));
    }

    const dir = join(dataDir, 'exports', namespace, String(run.id));
    mkdirSync(dir, { recursive: true });

    const files: ExportedFile[] = [];
    for (const fileName of EXPORT_FILE_ORDER) {
      const columns = [...COLUMNS_BY_FILE[fileName]];
      const text = toCsv(columns, byFile[fileName]);
      const path = join(dir, fileName);
      writeFileSync(path, text, 'utf8');
      const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
      const file: ExportedFile = { fileName, path, rowCount: byFile[fileName].length, columns, sha256 };
      upsertExportFile(db, run.id, file);
      files.push(file);
    }

    // Mirror FTS: podmiana chunków per dokument + sprzątnięcie dokumentów,
    // których nie ma już w stanie docelowym (wycofane/odrzucone po drodze).
    for (const doc of rows.mirror) {
      replaceForDocument(db, namespace, doc.docId, doc.chunks);
    }
    const keepIds = rows.mirror.map((d) => d.docId);
    const placeholders = keepIds.map(() => '?').join(',');
    db.prepare(
      `DELETE FROM chunks_mirror WHERE namespace = ?${keepIds.length > 0 ? ` AND doc_id NOT IN (${placeholders})` : ''}`,
    ).run(namespace, ...keepIds);

    // Krawędzie grafu: pełna podmiana per namespace (jak mirror) — kb_graph_neighbors.
    replaceEdgesForNamespace(db, namespace, rows.edges);

    // Manifest parametrów (GAP-04): w DB i obok CSV, żeby eksport dało się odtworzyć.
    const params = collectParams(db, namespace, drafts, opts, {
      docCount: rows.documents.length,
      chunkCount: rows.chunks.length,
      tombstoneCount: tombstones.length,
      supersededCount: rows.superseded.length,
    });
    writeFileSync(
      join(dir, '_manifest.json'),
      `${JSON.stringify({ runId: run.id, namespace, params, files: files.map((f) => ({ fileName: f.fileName, rowCount: f.rowCount, sha256: f.sha256 })) }, null, 2)}\n`,
      'utf8',
    );
    db.prepare('UPDATE export_runs SET params_json = ? WHERE id = ?').run(JSON.stringify(params), run.id);

    finishExportRun(db, run.id, 'success', { docCount: rows.documents.length, chunkCount: rows.chunks.length });
    return {
      runId: run.id,
      dir,
      files,
      docCount: rows.documents.length,
      chunkCount: rows.chunks.length,
      tombstones,
      superseded: rows.superseded,
      params,
    };
  } catch (err) {
    try {
      finishExportRun(db, run.id, 'error');
    } catch {
      /* run mógł zostać domknięty równolegle — wyjątek pierwotny jest ważniejszy */
    }
    throw err;
  }
}
