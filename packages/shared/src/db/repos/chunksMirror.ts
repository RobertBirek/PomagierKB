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

/**
 * Kolumny „prawdziwe" chunks_mirror. Migracja 0047 dołożyła kolumny GENERATED
 * (title_folded/content_folded) na potrzeby indeksu FTS — `SELECT *` wyciągałby
 * je do odpowiedzi API, więc wszędzie listujemy kolumny jawnie.
 */
const CHUNK_COLUMNS = 'id, namespace, doc_id, title, section_heading, content, source_ref, updated_at';

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
  const row = db.prepare(`SELECT ${CHUNK_COLUMNS} FROM chunks_mirror WHERE id = ?`).get(id) as
    | ChunkMirrorRow
    | undefined;
  return row ?? null;
}

/** Wszystkie chunki dokumentu w kolejności id (sufiks _NNN eksportera = kolejność sekcji). */
export function getDocumentChunks(db: Db, docId: string): ChunkMirrorRow[] {
  return db
    .prepare(`SELECT ${CHUNK_COLUMNS} FROM chunks_mirror WHERE doc_id = ? ORDER BY id`)
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

/** Sposób dopasowania wiersza: 'and' = wszystkie rdzenie (mocne), 'or' = luźny fallback. */
/** 'exact' — fraza dokładnego tokenu (wersja „1.84 SP1", identyfikator `tw__Towar`) jako podciąg. */
export type FtsMatchKind = 'and' | 'or' | 'exact';

export interface FtsResult {
  id: string;
  docId: string;
  namespace: string;
  title: string | null;
  snippet: string;
  bm25: number;
  /**
   * 'or' = trafienie wyłącznie z luźnego fallbacku po rdzeniach — sygnał SŁABY,
   * bramka odmowy (answer/verify) go nie akceptuje jako jedynego dowodu (D8-01/D8-04).
   */
  matchKind: FtsMatchKind;
}

// ── Normalizacja tekstu (audyt D8-04) ───────────────────────────────────────
//
// Indeks chunks_fts używa tokenizera 'trigram remove_diacritics 1', który składa
// ś/ż/ą/ę/ć/ń/ó/ź, ale NIE składa 'ł' (U+0142 nie dekomponuje się w NFD —
// zweryfikowane na SQLite 3.53.4). Dlatego migracja 0047 indeksuje kolumny
// GENERATED z 'ł'→'l', a zapytania przepuszczamy przez foldPolish() — dzięki temu
// wejście bez ogonków ('swiatla', 'przemyslowych') trafia w treść z ogonkami.

/** Składanie polskich znaków: lowercase + 'ł'→'l' + NFD bez znaków łączących. */
export function foldPolish(text: string): string {
  return text
    .toLowerCase()
    .replaceAll('ł', 'l')
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

/** foldPolish z mapą indeksów (znak złożony → pozycja w oryginale) — do snippetów. */
function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const f = foldPolish(text[i]!);
    for (const ch of f) {
      folded += ch;
      map.push(i);
    }
  }
  return { folded, map };
}

const MIN_TOKEN_LEN = 3; // tokenizer trigram nie dopasuje termu krótszego niż 3 znaki
const MIN_STEM_LEN = 3;
const MIN_OR_STEM_LEN = 5; // luźny OR tylko po długich rdzeniach (D8-04: 'świa' ⊄ fałszywe trafienia)

/**
 * Lekki stemmer PL: końcówki fleksyjne rzeczowników/przymiotników (po foldPolish,
 * więc 'ów'→'ow', 'ą'→'a'). Zastępuje ślepe „utnij 2 znaki", które gubiło alternacje
 * ('strumienia' → 'strumien' ≠ 'strumień') i formy typu 'haka' → 'hak'.
 */
const PL_SUFFIXES: readonly string[] = [
  'iami', 'iach', 'iemu', 'ego', 'emu', 'ych', 'ymi', 'ich', 'imi', 'ami', 'ach',
  'owi', 'owe', 'owa', 'iem', 'ow', 'om', 'em', 'ie', 'ia', 'ii', 'iu', 'ej', 'ym', 'im',
  'y', 'a', 'e', 'i', 'o', 'u',
]
  .slice()
  .sort((a, b) => b.length - a.length);

/** Rdzeń pojedynczego (już złożonego) tokenu; tokeny z cyfrą zostają bez zmian. */
export function stemPolish(token: string): string {
  if (/\d/.test(token) || token.length < 4) return token;
  for (const suffix of PL_SUFFIXES) {
    if (token.length - suffix.length >= MIN_STEM_LEN && token.endsWith(suffix)) {
      return token.slice(0, token.length - suffix.length);
    }
  }
  return token;
}

const quote = (t: string): string => `"${t.replaceAll('"', '""')}"`;

export interface QueryTerm {
  /** Rdzeń (do podświetlania w snippecie). */
  stem: string;
  /** Wyrażenie MATCH dla tego termu (cytowane; czasem grupa OR dla kodów typu „IP 65"). */
  expr: string;
}

/**
 * Zapytanie użytkownika → termy MATCH. Tokeny alfanumeryczne, bez stopwordów,
 * złożone (foldPolish) i sprowadzone do rdzenia; każdy jako cytowana fraza.
 * Sąsiadujące tokeny 2-znakowe, z których razem powstaje kod alfanumeryczny
 * („IP 65" → ip65), zostają zachowane jako grupa OR — inaczej trigram (min. 3 znaki)
 * gubiłby je bez śladu.
 */
export function queryTerms(query: string): QueryTerm[] {
  const original = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  const folded = original.map(foldPolish);
  const terms: QueryTerm[] = [];
  /** Krótki token wolno scalać tylko gdy to cyfry albo KOD pisany wielkimi literami. */
  const codeLike = (idx: number): boolean => {
    const raw = original[idx] ?? '';
    return /^\p{Nd}+$/u.test(raw) || raw === raw.toUpperCase();
  };
  for (let i = 0; i < folded.length; i++) {
    const token = folded[i]!;
    if (token === '') continue;
    if (token.length >= MIN_TOKEN_LEN) {
      if (PL_QUERY_STOPWORDS.has(token)) continue;
      const stem = stemPolish(token);
      if (PL_QUERY_STOPWORDS.has(stem)) continue;
      terms.push({ stem, expr: quote(stem) });
      continue;
    }
    // Token krótszy niż 3 znaki: sam w sobie nietrafialny przez trigram. Ratujemy
    // wyłącznie parę sąsiadujących krótkich tokenów tworzącą KOD litera+cyfra
    // pisany wielkimi literami („IP 65" → „ip65"/„ip 65"); przyimki typu „do 40"
    // ani „lm/W" nie łapią się na ten wyjątek. Pojedynczy krótki token odrzucamy.
    const next = folded[i + 1];
    if (next === undefined || next === '' || next.length >= MIN_TOKEN_LEN) continue;
    if (!codeLike(i) || !codeLike(i + 1)) continue;
    const merged = `${token}${next}`;
    if (merged.length < MIN_TOKEN_LEN || !/\d/.test(merged) || !/\p{L}/u.test(merged)) continue;
    terms.push({ stem: merged, expr: `(${quote(merged)} OR ${quote(`${token} ${next}`)})` });
    i++; // para skonsumowana
  }
  return terms;
}

/** Rdzenie zapytania (do podświetlania snippetów i diagnostyki). */
export function queryStems(query: string): string[] {
  return queryTerms(query).map((t) => t.stem);
}

export function buildMatchExpression(query: string): string | null {
  const terms = queryTerms(query);
  if (terms.length === 0) return null;
  return terms.map((t) => t.expr).join(' AND ');
}

/**
 * Luźniejszy wariant: OR po najdłuższych rdzeniach (fallback gdy AND = 0 trafień).
 * Minimalna długość rdzenia 5 znaków — krótsze ('świa', 'syst') dawały fałszywe
 * trafienia dla pytań spoza bazy (D8-04). Wyniki są znakowane matchKind='or'.
 */
export function buildOrMatchExpression(query: string, maxTerms = 4): string | null {
  const stems = [...new Set(queryTerms(query).map((t) => t.stem))]
    .filter((s) => s.length >= MIN_OR_STEM_LEN)
    .sort((a, b) => b.length - a.length)
    .slice(0, maxTerms);
  if (stems.length === 0) return null;
  return stems.map(quote).join(' OR ');
}

const SNIPPET_CHARS = 300;

/**
 * Snippet z treści chunka: okno ~300 znaków wokół pierwszego trafionego rdzenia,
 * podświetlane CAŁE słowa. Zastępuje snippet(chunks_fts,…,16), które dla tokenizera
 * trigram znaczyło 16 TRIGRAMÓW (~20 znaków, słowa ucięte w środku) — D8-05.
 */
export function buildFtsSnippet(content: string, stems: readonly string[], maxChars = SNIPPET_CHARS): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized === '') return '';
  const { folded, map } = foldWithMap(normalized);
  let start = 0;
  let found = -1;
  for (const stem of stems) {
    if (stem === '') continue;
    const at = folded.indexOf(stem);
    if (at >= 0 && (found < 0 || at < found)) found = at;
  }
  if (found >= 0) {
    const origAt = map[found] ?? 0;
    start = Math.max(0, origAt - Math.floor(maxChars / 3));
  }
  let end = Math.min(normalized.length, start + maxChars);
  // Nie tnij słów na krawędziach okna.
  if (start > 0) {
    const space = normalized.indexOf(' ', start);
    if (space >= 0 && space - start < 40) start = space + 1;
  }
  if (end < normalized.length) {
    const space = normalized.lastIndexOf(' ', end);
    if (space > start) end = space;
  }
  const window = normalized.slice(start, end);
  const highlighted = window
    .split(/(\s+)/)
    .map((word) => {
      if (word.trim() === '') return word;
      const foldedWord = foldPolish(word);
      return stems.some((s) => s !== '' && foldedWord.includes(s)) ? `<b>${word}</b>` : word;
    })
    .join('');
  return `${start > 0 ? '…' : ''}${highlighted}${end < normalized.length ? '…' : ''}`;
}

export function searchFts(db: Db, query: string, namespaces: string[], limit = 8): FtsResult[] {
  if (namespaces.length === 0) return [];
  const strict = buildMatchExpression(query);
  if (!strict) return [];
  const stems = queryStems(query);
  const first = runFtsQuery(db, strict, namespaces, limit, stems, 'and');
  if (first.length > 0) return first;
  // AND bez trafień (np. rzadki termin obok popularnych) → luźniejszy OR po rdzeniach.
  const loose = buildOrMatchExpression(query);
  if (!loose || loose === strict) return [];
  return runFtsQuery(db, loose, namespaces, limit, stems, 'or');
}

/**
 * Regex dokładnego tokenu (wersja „1.84 SP1", identyfikator `tw__Towar`): bez wielkości liter,
 * spacje między segmentami (cyfry/litery/inne) dowolne („1.84SP1" = „1.84 SP1"), granice słowa
 * po obu stronach („1.8" nie pasuje do „1.84", „dok_Typ" nie pasuje do „dok_TypX").
 */
export function exactTokenRegex(token: string): RegExp {
  const segments = token.toLowerCase().replace(/\s+/g, '').match(/[a-z]+|\d+|[^a-z\d]+/g) ?? [];
  const body = segments.map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, 'iu');
}

/**
 * Dokładne tokeny (wersje, identyfikatory) jako frazy-podciągi: tokenizer trigram dopasowuje
 * cytowaną frazę jako ciąg znaków, więc „1.84 sp1" trafia w treść z „1.84 SP1" niezależnie od
 * tego, że zwykłe termy zapytania (`queryTerms`) gubią „1" i „84" jako za krótkie. Wszystkie
 * tokeny muszą wystąpić (AND). Tokeny krótsze niż 3 znaki są pomijane (trigram ich nie widzi).
 */
export function searchFtsExact(db: Db, tokens: string[], namespaces: string[], limit = 8): FtsResult[] {
  if (namespaces.length === 0) return [];
  const phrases = [...new Set(tokens.map((t) => foldPolish(t).replace(/\s+/g, ' ').trim()))].filter(
    (t) => t.length >= MIN_TOKEN_LEN,
  );
  if (phrases.length === 0) return [];
  // Trigram dopasowuje PODCIĄG („1.2" trafia w „1.22") — granice tokenu egzekwuje regex na
  // tytule+treści; pula z FTS jest większa, żeby po odsiewie zostało `limit` wierszy.
  const regexes = tokens.map(exactTokenRegex);
  const keep = (r: FtsRow): boolean => regexes.every((re) => re.test(`${r.title ?? ''}\n${r.content}`));
  // Pas nagłówkowy: LIKE w SQL to wstępny odsiew (podciąg), granice tokenu sprawdza regex —
  // `InsSearch.len_tw__Towar` nie jest nagłówkiem o tabeli `tw__Towar`.
  const keepHeading = (r: FtsRow): boolean =>
    regexes.every((re) => re.test(`${r.title ?? ''}\n${r.section_heading ?? ''}`)) && keep(r);
  const match = phrases.map(quote).join(' AND ');
  // Najpierw chunki z tokenem w NAGŁÓWKU sekcji/tytule (opis tabeli `dbo.tw__Towar`, changelog
  // „Zmiany w InsERT GT 1.84 SP1"), potem reszta po bm25 — bm25 samo promuje chunki z wieloma
  // wystąpieniami (widoki SQL z `dbo.tw__Towar.` w każdej linii), a opis tabeli ma jedno.
  const inHeading = runFtsQuery(db, match, namespaces, limit, phrases, 'exact', keepHeading, phrases);
  const seen = new Set(inHeading.map((r) => r.id));
  const rest = runFtsQuery(db, match, namespaces, limit * 2, phrases, 'exact', keep).filter((r) => !seen.has(r.id));
  return [...inHeading, ...rest].slice(0, limit);
}

interface FtsRow {
  id: string;
  doc_id: string;
  namespace: string;
  title: string | null;
  content: string;
  section_heading: string | null;
  score: number;
}

function runFtsQuery(
  db: Db,
  match: string,
  namespaces: string[],
  limit: number,
  stems: readonly string[],
  matchKind: FtsMatchKind,
  keep: (row: FtsRow) => boolean = () => true,
  headingPhrases: readonly string[] = [],
): FtsResult[] {
  const placeholders = namespaces.map(() => '?').join(',');
  // LIKE po nagłówku sekcji/tytule (kolumny spoza indeksu FTS); `_` i `%` w tokenie escapowane.
  const likeOf = (phrase: string): string => `%${phrase.replace(/[\\%_]/g, '\\$&')}%`;
  const headingClause = headingPhrases
    .map(() => " AND (coalesce(c.section_heading, '') LIKE ? ESCAPE '\\' OR coalesce(c.title, '') LIKE ? ESCAPE '\\')")
    .join('');
  const headingParams = headingPhrases.flatMap((p) => [likeOf(p), likeOf(p)]);
  const rows = db
    .prepare(
      `SELECT c.id, c.doc_id, c.namespace, c.title, c.content, c.section_heading,
              bm25(chunks_fts) AS score
       FROM chunks_fts
       JOIN chunks_mirror c ON c.rowid = chunks_fts.rowid
       WHERE chunks_fts MATCH ? AND c.namespace IN (${placeholders})${headingClause}
       ORDER BY bm25(chunks_fts)
       LIMIT ?`,
    )
    .all(match, ...namespaces, ...headingParams, Math.min(Math.max(limit, 1), 50)) as FtsRow[];
  return rows
    .filter(keep)
    .map((r) => ({
      id: r.id,
      docId: r.doc_id,
      namespace: r.namespace,
      title: r.title,
      snippet: buildFtsSnippet(r.content, stems),
      bm25: r.score,
      matchKind,
    }));
}
