import type { Db } from '../open.js';
import { PL_QUERY_STOPWORDS } from '../../text/stopwords.js';
import { nowIso } from '../open.js';

/** Mirror chunków + FTS5 (trigram) — fallback retrievalu i snippety po polsku. */

export interface ChunkInput {
  id: string;
  title?: string | null;
  sectionHeading?: string | null;
  content: string;
  sourceRef?: string | null;
}

export interface ChunkMirrorRow {
  id: string;
  namespace: string;
  doc_id: string;
  title: string | null;
  section_heading: string | null;
  content: string;
  source_ref: string | null;
  updated_at: string;
}

/** Podmiana chunków dokumentu w jednej transakcji (delete+insert; triggery pilnują FTS). */
export function replaceForDocument(db: Db, namespace: string, docId: string, chunks: ChunkInput[]): void {
  const del = db.prepare('DELETE FROM chunks_mirror WHERE namespace = ? AND doc_id = ?');
  const ins = db.prepare(
    `INSERT OR REPLACE INTO chunks_mirror (id, namespace, doc_id, title, section_heading, content, source_ref, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    del.run(namespace, docId);
    const now = nowIso();
    for (const c of chunks) {
      ins.run(
        c.id,
        namespace,
        docId,
        c.title ?? null,
        c.sectionHeading ?? null,
        c.content,
        c.sourceRef ?? null,
        now,
      );
    }
  });
  tx.immediate();
}

/** Pojedynczy chunk z mirrora (pełna treść — kb_get_source). */
export function getChunk(db: Db, id: string): ChunkMirrorRow | null {
  const row = db.prepare('SELECT * FROM chunks_mirror WHERE id = ?').get(id) as
    | ChunkMirrorRow
    | undefined;
  return row ?? null;
}

/** Wszystkie chunki dokumentu w kolejności id (sufiks _NNN eksportera = kolejność sekcji). */
export function getDocumentChunks(db: Db, docId: string): ChunkMirrorRow[] {
  return db
    .prepare('SELECT * FROM chunks_mirror WHERE doc_id = ? ORDER BY id')
    .all(docId) as ChunkMirrorRow[];
}

export interface DocumentSummary {
  docId: string;
  title: string | null;
  chunks: number;
  sourceRef: string | null;
  updatedAt: string;
}

/** Przegląd dokumentów w KB (kb_list_documents): agregacja po doc_id + filtr tytułu. */
export function listDocuments(
  db: Db,
  namespace: string,
  opts: { q?: string; limit?: number; offset?: number } = {},
): { items: DocumentSummary[]; total: number } {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  const offset = Math.max(opts.offset ?? 0, 0);
  const like = opts.q !== undefined && opts.q !== '' ? `%${opts.q}%` : null;
  const where = like === null ? 'namespace = ?' : 'namespace = ? AND title LIKE ?';
  const args: unknown[] = like === null ? [namespace] : [namespace, like];
  const total = (
    db
      .prepare(`SELECT COUNT(DISTINCT doc_id) AS n FROM chunks_mirror WHERE ${where}`)
      .get(...args) as { n: number }
  ).n;
  const rows = db
    .prepare(
      `SELECT doc_id, MIN(title) AS title, COUNT(*) AS chunks, MIN(source_ref) AS source_ref,
              MAX(updated_at) AS updated_at
       FROM chunks_mirror WHERE ${where}
       GROUP BY doc_id ORDER BY MIN(title) IS NULL, MIN(title), doc_id
       LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset) as {
    doc_id: string;
    title: string | null;
    chunks: number;
    source_ref: string | null;
    updated_at: string;
  }[];
  return {
    items: rows.map((r) => ({
      docId: r.doc_id,
      title: r.title,
      chunks: r.chunks,
      sourceRef: r.source_ref,
      updatedAt: r.updated_at,
    })),
    total,
  };
}

export interface FtsResult {
  id: string;
  docId: string;
  namespace: string;
  title: string | null;
  snippet: string;
  bm25: number;
}

/**
 * Zapytanie użytkownika → bezpieczne wyrażenie MATCH: tokeny alfanumeryczne,
 * każdy jako cytowana fraza (escapowanie '"'), łączone AND. Tokenizer trigram
 * dopasowuje podciągi, więc dłuższe tokeny przycinamy o końcówkę fleksyjną
 * (np. 'szynoprzewodów' znajdzie też 'szynoprzewodach').
 */
// Stopwordy zapytań — jedno źródło w text/stopwords.ts (audyt: dwie rozbieżne listy).

function stems(query: string): string[] {
  const tokens = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => t.length >= 3 && !PL_QUERY_STOPWORDS.has(t));
  return tokens.map((t) => (t.length >= 6 ? t.slice(0, t.length - 2) : t));
}

const quote = (t: string): string => `"${t.replaceAll('"', '""')}"`;

export function buildMatchExpression(query: string): string | null {
  const s = stems(query);
  if (s.length === 0) return null;
  return s.map(quote).join(' AND ');
}

/** Luźniejszy wariant: OR po najdłuższych rdzeniach (fallback gdy AND = 0 trafień). */
export function buildOrMatchExpression(query: string, maxTerms = 4): string | null {
  const s = [...new Set(stems(query))].sort((a, b) => b.length - a.length).slice(0, maxTerms);
  if (s.length === 0) return null;
  return s.map(quote).join(' OR ');
}

export function searchFts(db: Db, query: string, namespaces: string[], limit = 8): FtsResult[] {
  if (namespaces.length === 0) return [];
  const strict = buildMatchExpression(query);
  if (!strict) return [];
  const first = runFtsQuery(db, strict, namespaces, limit);
  if (first.length > 0) return first;
  // AND bez trafień (np. rzadki termin obok popularnych) → luźniejszy OR po rdzeniach.
  const loose = buildOrMatchExpression(query);
  if (!loose || loose === strict) return [];
  return runFtsQuery(db, loose, namespaces, limit);
}

function runFtsQuery(db: Db, match: string, namespaces: string[], limit: number): FtsResult[] {
  const placeholders = namespaces.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT c.id, c.doc_id, c.namespace, c.title,
              snippet(chunks_fts, 1, '<b>', '</b>', '…', 16) AS snip,
              bm25(chunks_fts) AS score
       FROM chunks_fts
       JOIN chunks_mirror c ON c.rowid = chunks_fts.rowid
       WHERE chunks_fts MATCH ? AND c.namespace IN (${placeholders})
       ORDER BY bm25(chunks_fts)
       LIMIT ?`,
    )
    .all(match, ...namespaces, Math.min(Math.max(limit, 1), 50)) as {
    id: string;
    doc_id: string;
    namespace: string;
    title: string | null;
    snip: string;
    score: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    docId: r.doc_id,
    namespace: r.namespace,
    title: r.title,
    snippet: r.snip,
    bm25: r.score,
  }));
}
