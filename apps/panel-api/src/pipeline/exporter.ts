import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db, DraftRow } from '@pomagierkb/shared/db';
import {
  draftTags,
  finishExportRun,
  listDrafts,
  replaceForDocument,
  startExportRun,
  upsertExportFile,
  type ChunkInput,
} from '@pomagierkb/shared/db';
import { chunkDocument, makePreview, type DocumentChunk } from './chunker.js';

/**
 * EKSPORT CSV (Etap 7, docs/design/pipeline-frontend.md): źródło = WSZYSTKIE
 * drafty `promoted` danej KB (pełny rebuild stanu docelowego — id deterministyczne,
 * więc UPSERT w OpenSPG jest idempotentny). Pliki do DATA_DIR/exports/<ns>/<runId>/,
 * kolumny DOKŁADNIE 1:1 z properties szablonu schemas/document_kb.schema.tpl (+ id).
 * ODSTĘPSTWO projektowe: chunk.content jedzie w PEŁNEJ treści (≤1800 zn. z chunkera;
 * to ONO jest indeksowane TextAndVector — patrz szablon schemy).
 * Równolegle: mirror chunków do SQLite FTS5 (repo chunksMirror) + manifesty
 * export_runs/export_files (sha256) — resume buildu bez plików JSON.
 */

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

export const ENTITY_BY_FILE: Record<ExportFileName, string> = {
  'topic.csv': 'Topic',
  'reference_document.csv': 'ReferenceDocument',
  'chunk.csv': 'Chunk',
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
 * Stabilny 8-znakowy hash tożsamości dokumentu: sha1(ns + sourceRef|contentHash).
 * Preferuje sourceRef (id dokumentu przeżywa edycję treści → UPSERT podmienia),
 * bez sourceRef — hash treści.
 */
export function docHash8(namespace: string, draft: Pick<DraftRow, 'source_ref' | 'content_hash'>): string {
  const key = draft.source_ref !== null && draft.source_ref !== '' ? draft.source_ref : draft.content_hash;
  return sha1hex(`${namespace}|${key}`).slice(0, 8).toUpperCase();
}

export function docIdFor(namespace: string, draft: Pick<DraftRow, 'source_ref' | 'content_hash' | 'title'>): string {
  return `DOC_${docHash8(namespace, draft)}_${makeId(draft.title, 80)}`;
}

export function chunkIdFor(dh8: string, order: number): string {
  return `CHUNK_${dh8}_${String(order).padStart(3, '0')}`;
}

export function topicIdFor(tag: string): string {
  return `TOPIC_${makeId(tag)}`;
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

/** Nazwa chunka: «tytuł doc» — «heading|fragment» #N (≤180). */
function chunkName(title: string, chunk: DocumentChunk): string {
  const fragment = chunk.sectionHeading !== ''
    ? chunk.sectionHeading
    : makePreview(chunk.content.replace(/\s+/g, ' '), 60);
  return `${title} — ${fragment} #${chunk.sectionOrder + 1}`.slice(0, 180);
}

export interface ExportRows {
  topics: Record<string, string>[];
  documents: Record<string, string>[];
  chunks: Record<string, string>[];
  /** Wejście mirroru FTS per dokument (docId → chunki). */
  mirror: { docId: string; title: string; sourceRef: string | null; chunks: ChunkInput[] }[];
}

/** Buduje wiersze wszystkich trzech plików z promowanych draftów (bez IO). */
export function buildExportRows(
  namespace: string,
  drafts: DraftRow[],
  opts: { maxLen?: number; previewLen?: number } = {},
): ExportRows {
  const topics = new Map<string, { name: string; slug: string; docCount: number }>();
  const documents: Record<string, string>[] = [];
  const chunkRows: Record<string, string>[] = [];
  const mirror: ExportRows['mirror'] = [];

  for (const draft of drafts) {
    const analysis = parseJson<Record<string, unknown>>(draft.analysis_json, {});
    const metadata = parseJson<Record<string, unknown>>(draft.metadata_json, {});
    const tags = draftTags(draft);
    const dh8 = docHash8(namespace, draft);
    const docId = docIdFor(namespace, draft);
    const sourceUrl = draft.source_ref ?? '';
    const summary = makePreview(str(analysis['summary']), 400);
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
      name: draft.title,
      description: '',
      semanticType: 'reference_document',
      sourceUrl,
      sourceType: draft.source_type,
      documentCategory: draft.document_category ?? '',
      language: str(analysis['language']) || str(metadata['language']) || 'pl',
      sourceTier: str(metadata['sourceTier']),
      publishedAt: str(metadata['publishedAt']),
      retrievedAt: draft.created_at,
      topicRefIds: topicIds.join(','),
      conceptRefIds: '', // v1 bez concept.csv (sekcja b projektu)
      content: draft.content_md,
      contentPreview: makePreview(draft.content_md),
      contentHash: draft.content_hash,
      contentLength: String(draft.content_length),
      summary,
    });

    const docChunks = chunkDocument(draft.content_md, opts);
    const mirrorChunks: ChunkInput[] = [];
    for (const chunk of docChunks) {
      const chunkId = chunkIdFor(dh8, chunk.sectionOrder);
      chunkRows.push({
        id: chunkId,
        name: chunkName(draft.title, chunk),
        description: '',
        semanticType: 'chunk',
        sourceDocumentRefId: docId,
        sourceUrl,
        sectionHeading: chunk.sectionHeading,
        sectionOrder: String(chunk.sectionOrder),
        content: chunk.content,
        contentPreview: chunk.contentPreview,
        contentHash: chunk.contentHash,
        contentLength: String(chunk.contentLength),
      });
      mirrorChunks.push({
        id: chunkId,
        title: draft.title,
        sectionHeading: chunk.sectionHeading === '' ? null : chunk.sectionHeading,
        content: chunk.content,
        sourceRef: draft.source_ref,
      });
    }
    mirror.push({ docId, title: draft.title, sourceRef: draft.source_ref, chunks: mirrorChunks });
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

  return { topics: topicRows, documents, chunks: chunkRows, mirror };
}

// ── runExport: pliki + manifesty + mirror ───────────────────────────────────

export interface ExportedFile {
  fileName: ExportFileName;
  path: string;
  rowCount: number;
  columns: string[];
  sha256: string;
}

export interface ExportResult {
  runId: number;
  dir: string;
  files: ExportedFile[];
  docCount: number;
  chunkCount: number;
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

/**
 * Eksport KB: promowane drafty → 3 pliki CSV w DATA_DIR/exports/<ns>/<runId>/
 * + manifest (export_runs/export_files z sha256) + mirror FTS5. Błąd w trakcie
 * → run zamknięty statusem 'error' i wyjątek idzie dalej.
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

    const dir = join(dataDir, 'exports', namespace, String(run.id));
    mkdirSync(dir, { recursive: true });

    const byFile: Record<ExportFileName, Record<string, string>[]> = {
      'topic.csv': rows.topics,
      'reference_document.csv': rows.documents,
      'chunk.csv': rows.chunks,
    };

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

    finishExportRun(db, run.id, 'success', { docCount: rows.documents.length, chunkCount: rows.chunks.length });
    return { runId: run.id, dir, files, docCount: rows.documents.length, chunkCount: rows.chunks.length };
  } catch (err) {
    try {
      finishExportRun(db, run.id, 'error');
    } catch {
      /* run mógł zostać domknięty równolegle — wyjątek pierwotny jest ważniejszy */
    }
    throw err;
  }
}
