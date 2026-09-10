import type { Db } from '../db/index.js';
import { exactTokenRegex, foldPolish, listKbs, searchFts, searchFtsExact, type FtsResult, type KbRow } from '../db/index.js';
import { PL_QUERY_STOPWORDS } from '../text/stopwords.js';
import { rrfFuse, searchText, searchVector } from '../openspg/index.js';
import type { OpenSpgClient, RankedList, SearchHit } from '../openspg/index.js';
import { routeNamespaces } from './routing.js';
import { withBreaker } from '../llm/index.js';
import type { ChatRequest, ChatResult } from '../llm/index.js';

/**
 * Retrieval hybrydowy (backend-mcp §7.5): trzy kanały równolegle
 *  (a) FTS5 trigram na chunks_mirror (lokalny, synchroniczny — polska fleksja),
 *  (b) OpenSPG search/vector (embed zapytania po naszej stronie),
 *  (c) OpenSPG search/text,
 * fuzja RRF (k=60), dedup po id. Fallback FTS5 jest bezpiecznikiem, nie substytutem
 * OpenSPG — degraded:true gdy działał tylko FTS5 (albo OpenSPG nic nie znalazł,
 * a mirror tak).
 *
 * Moduł WSPÓŁDZIELONY (mcp-server + panel-api): zamiast ToolCtx przyjmuje
 * zgeneralizowany AnswerCtx {db, llm, openspg, log}, a allowedNamespaces są
 * przekazywane JAWNIE w parametrach (wołający decyduje: profil klucza MCP
 * albo wszystkie aktywne KB w panelu).
 */

/** Klient LLM wymagany przez retrieval/answer (strukturalnie zgodny z ToolLlm mcp-servera). */
export interface AnswerLlm {
  chat(req: ChatRequest): Promise<ChatResult>;
  embed(texts: string[]): Promise<number[][]>;
}

/** Minimalny logger (kompatybilny z pino/fastify req.log). */
export interface AnswerLog {
  warn(obj: Record<string, unknown>, msg?: string): void;
}

/** Zgeneralizowany kontekst odpowiedzi — bez zależności od transportu (MCP/HTTP). */
export interface AnswerCtx {
  db: Db;
  /** null = LLM nieskonfigurowany (kanał wektorowy pomijany, answer niedostępne). */
  llm: AnswerLlm | null;
  /** null = OpenSPG niedostępny (retrieval degraduje się do FTS5). */
  openspg: OpenSpgClient | null;
  log: AnswerLog;
}

export type RetrievalSource = 'fallback_fts' | 'openspg_vector' | 'openspg_text' | 'exact_match';
export type RetrievalMode = 'hybrid' | 'text' | 'vector';

export interface RetrievalHit {
  id: string;
  namespace: string;
  title?: string;
  snippet: string;
  /** Score fuzji RRF (mierzy ZGODNOŚĆ kanałów, nie trafność — patrz vectorScore). */
  score: number;
  /**
   * Surowy cosinus kanału OpenSPG search/vector (0..1) — JEDYNY sygnał realnej
   * trafności semantycznej w wyniku. Bramka odmowy (D8-01) opiera się na nim,
   * bo RRF nie odróżnia „rank 1 wśród trafnych" od „rank 1 wśród nietrafnych".
   * Uwaga: porównywalny WEWNĄTRZ projektu OpenSPG (zamrożony model embeddingu).
   */
  vectorScore?: number;
  source: RetrievalSource;
  sourceRef?: string;
  /**
   * Dokument źródłowy i nagłówek sekcji, z której pochodzi chunk.
   *
   * Oba pola SĄ w `chunks_mirror` i w schemacie grafu od początku — do 2026-09-07 po prostu
   * nie były przepuszczane tutaj, więc cytowanie mówiło „ten fragment", a nie „ten dokument,
   * sekcja Montaż". Bez nich nie da się rozstrzygnąć, czy zła odpowiedź to wina modelu,
   * retrievalu, czy podziału źródła na fragmenty — a to trzy różne naprawy.
   */
  docId?: string;
  sectionHeading?: string;
}

export interface HybridSearchParams {
  query: string;
  /**
   * Wariant zapytania dla kanałów TEKSTOWYCH (FTS + OpenSPG text) — query
   * rewriting; kanał wektorowy zawsze embeduje oryginalne `query`. Default = query.
   */
  textQuery?: string;
  /** Zbiór namespace dozwolonych dla wołającego — przekazywany JAWNIE. */
  allowedNamespaces: string[];
  namespaces?: string[];
  limit?: number;
  mode?: RetrievalMode;
}

/** Powody degradacji — do diagnostyki agenta/panelu (degraded = reasons.length > 0). */
export type DegradedReason =
  | 'openspg_down' // żaden kanał OpenSPG nie zadziałał (awaria/timeout/breaker)
  | 'openspg_no_hits' // OpenSPG działał, ale nic nie znalazł, a lokalny mirror tak
  | 'embed_failed' // embed zapytania zawiódł → kanał wektorowy pominięty (OpenSPG zdrowy!)
  | 'snippet_only' // któryś wynik bez pełnej treści (tylko 300-znakowy snippet)
  | 'kb_dirty'; // przeszukana KB ma zmiany nie wbudowane w graf (mirror może wyprzedzać)

export interface RetrievalResult {
  results: RetrievalHit[];
  degraded: boolean;
  degradedReasons: DegradedReason[];
  /** Liczba kanałów, które realnie weszły do fuzji (normalizacja topScore w answer). */
  activeChannels: number;
  /**
   * Najwyższy surowy cosinus kanału wektorowego (null = kanał nie zadziałał).
   * Sygnał trafności dla bramki odmowy — patrz RetrievalHit.vectorScore.
   */
  topVectorScore: number | null;
  /**
   * true = kanał FTS trafił wyrażeniem AND (wszystkie rdzenie zapytania).
   * false = brak trafień albo tylko luźny fallback OR (słaby dowód: podciąg rdzenia
   * potrafi trafić pytanie spoza bazy — D8-04). Bramka odmowy tego wymaga, gdy
   * nie ma żadnego sygnału semantycznego.
   */
  lexicalStrict: boolean;
  /** Namespace'y wzmocnione przez routing hints (kb_registry.routing_keywords). */
  matchedRouting: string[];
  tookMs: number;
  /**
   * Czas każdego kanału w ms (`fallback_fts`, `openspg_vector`, `openspg_text`).
   * Sam `tookMs` mówi, że retrieval trwał 2 s, ale nie który kanał to zjadł — a to
   * różnica między „wolny OpenSPG" a „wolny dostawca embeddingów".
   */
  channelMs: Record<string, number>;
}

const CHANNEL_TIMEOUT_MS = 5000;
const SNIPPET_MAX = 300;
/**
 * Minimalny score kanału OpenSPG search/text. Kanał dopasowuje DOKŁADNE tokeny bez
 * stopwordów, więc trafienia „stopwordowe" mają score 0.12–0.28, a merytoryczne
 * 0.43–1.8 (audyt D8-03, evidence/D8-openspg-text-stopwords.txt).
 */
const OPENSPG_TEXT_MIN_SCORE = 0.3;

/** Wewnętrzny, znormalizowany hit pojedynczego kanału (kolejność = ranking). */
interface ChannelHit {
  id: string;
  namespace: string;
  title?: string;
  snippet?: string;
  sourceRef?: string;
  docId?: string;
  sectionHeading?: string;
  /** Surowy score kanału (tylko wektorowy — do bramki trafności). */
  score?: number;
}

function truncateSnippet(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > SNIPPET_MAX ? `${clean.slice(0, SNIPPET_MAX)}…` : clean;
}

function firstString(fields: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = fields[k];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return undefined;
}

/**
 * Quirk buildera OpenSPG (zweryfikowany live 2026-09-04): property importowane
 * z CSV są przechowywane z LITERALNYMI cudzysłowami (`"\"Tytuł\""`). Strip
 * w jednym miejscu — wszystkie pola tekstowe z kanałów OpenSPG przechodzą tędy.
 */
export function stripLiteralQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

const EXPORT_ID_RE = /^(CHUNK_|DOC_|TOPIC_)/;

/**
 * Kanały OpenSPG zwracają w zewnętrznym `docId`/`id` NUMERYCZNY id węzła
 * (zweryfikowane live: docId "8"), a nasz id eksportera siedzi w properties.id.
 * Bez rozwiązania takie trafienie truje fuzję i cytowania (id bezużyteczne dla
 * kb_get_source/kb_entity_get). Zwraca id w konwencji eksportera albo null
 * (trafienie do odrzucenia).
 */
export function resolveExportId(hit: SearchHit): string | null {
  const outer = stripLiteralQuotes(hit.id);
  if (EXPORT_ID_RE.test(outer)) return outer;
  const inner = hit.fields['id'];
  if (typeof inner === 'string') {
    const clean = stripLiteralQuotes(inner);
    if (EXPORT_ID_RE.test(clean)) return clean;
  }
  return null;
}

/**
 * Zapytanie dla kanału OpenSPG search/text (D8-03). Kanał robi dopasowanie
 * DOKŁADNYCH tokenów bez stopwordów i stemmingu, więc każde polskie pytanie
 * („na", „w", „do") zwracało WSZYSTKIE węzły ze score ~0.15 i wchodziło do fuzji
 * jako rank 1. Zostawiamy tokeny ≥3 znaków spoza listy stopwordów, w oryginalnej
 * formie (kanał nie ma stemmera — rdzeń i tak by nie trafił).
 */
export function buildOpenSpgTextQuery(query: string): string | null {
  const tokens = (query.match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => {
    if (t.length < 3) return false;
    const folded = foldPolish(t);
    return !PL_QUERY_STOPWORDS.has(t.toLowerCase()) && !PL_QUERY_STOPWORDS.has(folded);
  });
  return tokens.length > 0 ? tokens.join(' ') : null;
}

function toChannelHit(hit: SearchHit, namespace: string, resolvedId?: string): ChannelHit {
  const title = firstString(hit.fields, ['title', 'name']);
  const content = firstString(hit.fields, [
    'content',
    'contentPreview',
    'descriptionPreview',
    'description',
    'summary',
  ]);
  const sourceRef = firstString(hit.fields, ['sourceRef', 'source_ref', 'sourceUrl', 'url']);
  const docId = firstString(hit.fields, ['sourceDocumentRefId', 'source_document_ref_id', 'docId']);
  const sectionHeading = firstString(hit.fields, ['sectionHeading', 'section_heading']);
  return {
    id: resolvedId ?? hit.id,
    namespace,
    ...(title !== undefined ? { title: stripLiteralQuotes(title) } : {}),
    ...(content !== undefined ? { snippet: truncateSnippet(stripLiteralQuotes(content)) } : {}),
    ...(sourceRef !== undefined ? { sourceRef: stripLiteralQuotes(sourceRef) } : {}),
    ...(docId !== undefined ? { docId: stripLiteralQuotes(docId) } : {}),
    ...(sectionHeading !== undefined ? { sectionHeading: stripLiteralQuotes(sectionHeading) } : {}),
  };
}

/**
 * Kanał async z timeoutem 5 s: błąd/timeout → null (kanał "nie zadziałał"),
 * nigdy nie wywraca całego retrievalu.
 *
 * D8-10: po upływie deadline'u kanał nie tylko PRZESTAJE CZEKAĆ — `signal`
 * realnie anuluje żądanie HTTP (OpenSpgClient.withSignal). Bez tego zerwane
 * żądanie leciało dalej z własnym 30-sekundowym timeoutem klienta i breaker
 * 'openspg' otwierał się dopiero po ~3×30 s zamiast po 3×5 s.
 */
async function runChannel(
  ctx: AnswerCtx,
  name: string,
  run: (signal: AbortSignal) => Promise<ChannelHit[]>,
  /** Zbiera czas kanału w ms — łączny `tookMs` nie mówi, który kanał go zjadł. */
  timings?: Record<string, number>,
): Promise<ChannelHit[] | null> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, CHANNEL_TIMEOUT_MS);
  });
  try {
    const value = await Promise.race([run(controller.signal), timeout]);
    if (value === null) ctx.log.warn({ channel: name }, 'retrieval: kanał przekroczył timeout 5s');
    return value;
  } catch (err) {
    ctx.log.warn(
      { channel: name, err: err instanceof Error ? err.message : String(err) },
      'retrieval: kanał zawiódł',
    );
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Zwycięstwo wyścigu przez `run` też kończy kanał — nie zostawiamy żywego
    // kontrolera (żądanie i tak się już zakończyło).
    controller.abort();
    // Także dla kanału, który padł albo trafił w timeout: „openspg_vector zjadł 5000 ms"
    // to najważniejsza informacja przy diagnozie wolnej odpowiedzi.
    if (timings !== undefined) timings[name] = Date.now() - startedAt;
  }
}

interface MirrorRow {
  id: string;
  namespace: string;
  title: string | null;
  content: string;
  source_ref: string | null;
  doc_id: string | null;
  section_heading: string | null;
}

/** Wzbogacenie finalnych wyników o dane z chunks_mirror (tytuł/snippet/sourceRef). */
function mirrorLookup(db: Db, ids: string[]): Map<string, MirrorRow> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, namespace, title, content, source_ref, doc_id, section_heading
         FROM chunks_mirror WHERE id IN (${placeholders})`,
    )
    .all(...ids) as MirrorRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Id WYCOFANE ze stanu docelowego (`graph_ids.live = 0`).
 *
 * Builder OpenSPG działa w trybie UPSERT i — co potwierdziła przebudowa produkcji
 * 2026-09-06 — nie nadpisuje węzła wierszem-nagrobkiem: stary węzeł zachowuje pełną treść
 * i `semanticType`, mimo że job kończy się sukcesem. Kanały OpenSPG zwracają go wtedy
 * normalnie, z tym samym score co żywy odpowiednik. Dopóki upstream jest zamrożony,
 * JEDYNYM skutecznym miejscem egzekwowania wycofania jest ta bramka: hit, o którym rejestr
 * mówi „to już nie należy do bazy", nie może trafić do odpowiedzi ani do cytowań.
 *
 * Świadomie po `graph_ids`, a nie po `chunks_mirror`: kanał tekstowy pyta też o
 * `Ns.ReferenceDocument`, a dokumentów w mirrorze nie ma — filtr po mirrorze odciąłby
 * legalne trafienia. Id nieznane rejestrowi zostawiamy (bazy sprzed rejestru).
 */
function withdrawnIds(db: Db, ids: string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id FROM graph_ids WHERE live = 0 AND id IN (${placeholders})`)
    .all(...ids) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/** Priorytet oznaczenia źródła: OpenSPG przed fallbackiem lokalnym. */
// ── Wzmocnienie dokładnych tokenów (wersje, identyfikatory) ─────────────────
//
// Przy 42 tys. chunków (SubiektKB) pytania o konkretną wersję („nowości w 1.84 SP1") trafiały
// w sąsiednie numery (1.48 SP1, 1.06 SP1): embeddingi nie rozróżniają numerów, trigram gubi
// „1" i „84" jako za krótkie, a RRF mierzy zgodność kanałów, nie obecność tokenu. Dwa mechanizmy:
// (1) osobna lista FTS z frazami-podciągami tokenów (`searchFtsExact`) wchodzi do fuzji RRF jak
// dodatkowy kanał, (2) każdy kandydat, którego tytuł+treść zawiera WSZYSTKIE tokeny, dostaje
// stały bonus do score RRF. Bonus = dwa „pierwsze miejsca" w kanale: wygrywa z pojedynczym
// kanałem, ale NIE z konsensusem trzech kanałów — token obecny w setkach chunków (widoki SQL
// z `tw__Towar`) nie może wyprzeć kandydata, który pasuje leksykalnie i semantycznie. Zwykłe
// liczby, daty i kwoty NIE są tokenami — tylko wersje `d.d[ SPn][ HFn]` i identyfikatory z „_".

const VERSION_TOKEN_RE = /\b\d+\.\d+(?:\s*(?:SP|HF)\s*\d+)*\b/gi;
const IDENT_TOKEN_RE = /\b[A-Za-z][A-Za-z0-9]*_+[A-Za-z0-9_]*[A-Za-z0-9]\b/g;
/** Pula FTS przy dokładnych tokenach — krotność limitu. */
export const EXACT_TOKEN_FTS_POOL = 3;
/** Bonus RRF za komplet tokenów w tytule+treści (k=60 jak w `rrfFuse`): 2 × 1/(k+1). */
export const EXACT_TOKEN_BONUS = 2 / 61;

/** Dokładne tokeny z pytania: wersje i identyfikatory, w kolejności wystąpienia, bez duplikatów. */
export function extractExactTokens(query: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (t: string): void => {
    const norm = t.toLowerCase().replace(/\s+/g, '');
    if (norm.length < 3 || seen.has(norm)) return;
    seen.add(norm);
    out.push(t.trim());
  };
  // „1.5 mln" też pasuje do wzorca wersji — akceptowany szum: bonus działa tylko, gdy kandydat
  // faktycznie zawiera token, więc fałszywy token nie zmienia rankingu.
  for (const m of query.matchAll(VERSION_TOKEN_RE)) add(m[0]);
  for (const m of query.matchAll(IDENT_TOKEN_RE)) add(m[0]);
  return out;
}

/**
 * Kandydaci zawierający wszystkie tokeny (w tytule lub treści) dostają `EXACT_TOKEN_BONUS` do
 * score i źródło 'exact_match' (widoczne w kb_search/kokpicie); lista jest sortowana ponownie
 * po score (stabilnie — remis zachowuje kolejność wejściową). Bez tokenów lub bez dopasowań
 * zwraca wejście bez zmian.
 */
export function applyExactTokenBoost<T extends { id: string; score: number; sources: string[] }>(
  ranked: T[],
  tokens: string[],
  textOf: (id: string) => string,
): T[] {
  if (tokens.length === 0 || ranked.length === 0) return ranked;
  const regexes = tokens.map(exactTokenRegex);
  let matched = 0;
  const boosted = ranked.map((hit) => {
    const text = textOf(hit.id);
    if (text === '' || !regexes.every((re) => re.test(text))) return hit;
    matched++;
    return { ...hit, score: hit.score + EXACT_TOKEN_BONUS, sources: [...hit.sources, 'exact_match'] };
  });
  if (matched === 0) return ranked;
  return boosted
    .map((hit, i) => ({ hit, i }))
    .sort((a, b) => b.hit.score - a.hit.score || a.i - b.i)
    .map((x) => x.hit);
}

function pickSource(sources: string[]): RetrievalSource {
  if (sources.includes('exact_match')) return 'exact_match';
  if (sources.includes('openspg_vector')) return 'openspg_vector';
  if (sources.includes('openspg_text')) return 'openspg_text';
  return 'fallback_fts';
}

export async function hybridSearch(
  ctx: AnswerCtx,
  params: HybridSearchParams,
): Promise<RetrievalResult> {
  const started = Date.now();
  const limit = Math.min(Math.max(params.limit ?? 8, 1), 20);
  const mode: RetrievalMode = params.mode ?? 'hybrid';
  const textQuery = params.textQuery !== undefined && params.textQuery.trim() !== '' ? params.textQuery : params.query;
  const allowed = new Set(params.allowedNamespaces);
  const namespaces = (
    params.namespaces && params.namespaces.length > 0 ? params.namespaces : params.allowedNamespaces
  ).filter((ns) => allowed.has(ns));
  if (namespaces.length === 0) {
    return {
      results: [],
      degraded: true,
      degradedReasons: ['openspg_down'],
      activeChannels: 0,
      topVectorScore: null,
      lexicalStrict: false,
      matchedRouting: [],
      tookMs: Date.now() - started,
      channelMs: {}, // żaden kanał nie wystartował — pusta mapa, nie zera
    };
  }
  // Jedna mapa rejestru na całe wyszukiwanie (zamiast getKb per namespace per kanał — N+1).
  const kbMap = new Map<string, KbRow>(listKbs(ctx.db).map((kb) => [kb.namespace, kb]));

  // Routing hints: wagi per KB z routing_keywords/nazwy (tylko re-ważenie fuzji;
  // jawny parametr namespaces nie jest modyfikowany).
  const routing = routeNamespaces(
    params.query,
    namespaces.map((ns) => {
      const kb = kbMap.get(ns);
      let keywords: string[] = [];
      try {
        const parsed: unknown = JSON.parse(kb?.routing_keywords ?? '[]');
        if (Array.isArray(parsed)) keywords = parsed.filter((k): k is string => typeof k === 'string');
      } catch {
        keywords = [];
      }
      return { namespace: ns, name: kb?.name ?? ns, routingKeywords: keywords };
    }),
  );

  /**
   * Ranking kanału z list per-namespace przez WAŻONY RRF (zamiast globalnego sortu
   * po surowych score'ach — nieporównywalne między projektami OpenSPG: najgęstsza
   * baza dominowała top-k). Każda KB wnosi ranking, routing hints ważą wkład.
   */
  const fusePerNamespace = (byNs: Map<string, ChannelHit[]>, cap = limit): ChannelHit[] => {
    if (byNs.size <= 1) {
      const only = [...byNs.values()][0] ?? [];
      return only.slice(0, cap);
    }
    const lists: RankedList[] = [...byNs.entries()].map(([ns, items]) => ({
      source: ns,
      items,
      weight: routing.weights.get(ns) ?? 1,
    }));
    const byId = new Map<string, ChannelHit>();
    for (const items of byNs.values()) for (const h of items) if (!byId.has(h.id)) byId.set(h.id, h);
    return rrfFuse(lists)
      .slice(0, cap)
      .map((f) => byId.get(f.id))
      .filter((h): h is ChannelHit => h !== undefined);
  };

  const channelMs: Record<string, number> = {};
  // Alias zamykający mapę czasów — dzięki niemu wywołania kanałów niżej zostają
  // jednolinijkowe i czytelne, zamiast rosnąć o kolejny argument w każdym miejscu.
  const runChannelTimed = (
    ctxArg: AnswerCtx,
    name: string,
    run: (signal: AbortSignal) => Promise<ChannelHit[]>,
  ): Promise<ChannelHit[] | null> => runChannel(ctxArg, name, run, channelMs);

  // (a) FTS5 — synchroniczny (better-sqlite3), timeout nie dotyczy; błąd → pusty kanał.
  let ftsHits: ChannelHit[] = [];
  let lexicalStrict = false;
  const ftsStartedAt = Date.now();
  const exactTokens = extractExactTokens(params.query);
  // Przy dokładnych tokenach kanał lokalny dostaje szerszą pulę i drugą listę (frazy-podciągi
  // tokenów przez trigram) — osobną w fuzji RRF, żeby zgodność z listą zwykłych termów była
  // nagradzana jak zgodność kanałów, a nie żeby sama fraza dominowała ranking.
  const ftsLimit = exactTokens.length > 0 ? limit * EXACT_TOKEN_FTS_POOL : limit;
  let ftsExactHits: ChannelHit[] = [];
  /** Re-ważenie routingiem także w kanale lokalnym (spójnie z kanałami OpenSPG). */
  const toChannelHits = (rows: FtsResult[], cap: number): ChannelHit[] => {
    const byNs = new Map<string, ChannelHit[]>();
    for (const r of rows) {
      const h: ChannelHit = { id: r.id, namespace: r.namespace, snippet: r.snippet, ...(r.title !== null ? { title: r.title } : {}) };
      const list = byNs.get(h.namespace);
      if (list === undefined) byNs.set(h.namespace, [h]);
      else list.push(h);
    }
    return fusePerNamespace(byNs, cap);
  };
  try {
    const ftsRows = searchFts(ctx.db, textQuery, namespaces, ftsLimit);
    // AND = wszystkie rdzenie zapytania w chunku; OR to luźny fallback (słaby dowód).
    lexicalStrict = ftsRows.length > 0 && ftsRows.every((r) => r.matchKind === 'and');
    ftsHits = toChannelHits(ftsRows, ftsLimit);
    if (exactTokens.length > 0) {
      // Bramka odmowy (`lexicalStrict`) ŚWIADOMIE nie patrzy na tę listę: sama obecność
      // „1.2" w korpusie nie czyni pytania o Fiata Punto 1.2 pytaniem na temat.
      ftsExactHits = toChannelHits(searchFtsExact(ctx.db, exactTokens, namespaces, ftsLimit), ftsLimit);
    }
  } catch (err) {
    ctx.log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'retrieval: FTS5 zawiódł',
    );
  }
  channelMs['fallback_fts'] = Date.now() - ftsStartedAt;

  // (b)+(c) OpenSPG — równolegle, każdy z własnym timeoutem 5 s i breakerem
  // ('openspg' w tabeli breakers: otwarty → kanał od razu null, kokpit widzi stan).
  const openspg = ctx.openspg;
  const llm = ctx.llm;
  const vectorNamespaces = namespaces.filter((ns) => (kbMap.get(ns)?.embedding_model ?? '') !== '');
  const vectorEnabled = mode !== 'text' && openspg !== null && llm !== null && vectorNamespaces.length > 0;
  const textEnabled = mode !== 'vector' && openspg !== null;
  const openspgTextQuery = buildOpenSpgTextQuery(textQuery);

  // Embed zapytania POZA breakerem 'openspg' (D8-10): awaria/limit OpenAI nie może
  // otwierać breakera OpenSPG i wyłączać zdrowego kanału tekstowego. Promise startuje
  // równolegle z kanałem tekstowym (bez utraty równoległości) i NIGDY nie odrzuca.
  let embedFailed = false;
  const queryVectorPromise: Promise<number[] | null> =
    vectorEnabled && llm !== null
      ? llm.embed([params.query]).then(
          (vectors) => {
            const qv = vectors[0];
            if (qv === undefined || qv.length === 0) {
              embedFailed = true;
              return null;
            }
            return qv;
          },
          (err: unknown) => {
            embedFailed = true;
            ctx.log.warn(
              { channel: 'openspg_vector', err: err instanceof Error ? err.message : String(err) },
              'retrieval: embed zapytania zawiódł — kanał wektorowy pominięty (OpenSPG bez zmian)',
            );
            return null;
          },
        )
      : Promise.resolve(null);

  const [vectorHits, textHits] = await Promise.all([
    vectorEnabled && openspg && llm
      ? runChannelTimed(ctx, 'openspg_vector', async (signal) => {
          const queryVector = await queryVectorPromise;
          // Rzucamy PRZED withBreaker → kanał „nie zadziałał", breaker 'openspg' nietknięty.
          if (queryVector === null) throw new Error('embed zapytania niedostępny');
          // Klient anulowany deadline'em kanału (sesja współdzielona z oryginałem).
          const scoped = openspg.withSignal(signal);
          return withBreaker(ctx.db, 'openspg', async () => {
            const byNs = new Map<string, ChannelHit[]>();
            for (const ns of vectorNamespaces) {
              const projectId = kbMap.get(ns)?.project_id;
              if (projectId === null || projectId === undefined) continue; // KB bez provisioningu
              const res = await searchVector(scoped, {
                projectId,
                label: `${ns}.Chunk`,
                propertyKey: 'content',
                queryVector,
                topk: limit,
              });
              // kolejność per KB wg score (porównywalne WEWNĄTRZ projektu);
              // id rozwiązywane do konwencji eksportera (numeryczne id węzła → drop)
              byNs.set(
                ns,
                [...res.items]
                  .sort((a, b) => b.score - a.score)
                  .map((h): ChannelHit | null => {
                    const id = resolveExportId(h);
                    // surowy cosinus NIESIONY dalej (bramka trafności — D8-01)
                    return id === null ? null : { ...toChannelHit(h, ns, id), score: h.score };
                  })
                  .filter((h): h is ChannelHit => h !== null),
              );
            }
            return fusePerNamespace(byNs);
          });
        })
      : Promise.resolve(null),
    // Zapytanie bez stopwordów; gdy nic nie zostaje (samo „co to jest?"), kanał
    // uznajemy za DZIAŁAJĄCY z zerem trafień — inaczej raportowałby fałszywy openspg_down.
    !(textEnabled && openspg)
      ? Promise.resolve(null)
      : openspgTextQuery === null
      ? Promise.resolve<ChannelHit[]>([])
      : runChannelTimed(ctx, 'openspg_text', (signal) => {
          const scoped = openspg.withSignal(signal);
          return withBreaker(ctx.db, 'openspg', async () => {
            // TextSearchRequest wymaga projectId — wołamy per namespace i scalamy;
            // ns znany z pętli (id eksportera to DOC_/CHUNK_ — nie niesie namespace).
            const byNs = new Map<string, ChannelHit[]>();
            for (const ns of namespaces) {
              const projectId = kbMap.get(ns)?.project_id;
              if (projectId === null || projectId === undefined) continue;
              const res = await searchText(scoped, {
                projectId,
                queryString: openspgTextQuery,
                labelConstraints: [`${ns}.Chunk`, `${ns}.ReferenceDocument`],
                page: 1,
                topk: limit,
              });
              byNs.set(
                ns,
                [...res.items]
                  // odsiew trafień „stopwordowych" (score < 0.3) PRZED sortem — D8-03
                  .filter((h) => h.score >= OPENSPG_TEXT_MIN_SCORE)
                  .sort((a, b) => b.score - a.score)
                  .map((h) => {
                    const id = resolveExportId(h);
                    return id === null ? null : toChannelHit(h, ns, id);
                  })
                  .filter((h): h is ChannelHit => h !== null),
              );
            }
            return fusePerNamespace(byNs);
          });
        }),
  ]);

  // Fuzja RRF + dedup po id (rrfFuse deduplikuje w obrębie i między listami).
  const lists: RankedList[] = [];
  if (ftsHits.length > 0) lists.push({ source: 'fallback_fts', items: ftsHits });
  if (ftsExactHits.length > 0) lists.push({ source: 'fallback_fts', items: ftsExactHits });
  if (vectorHits !== null) lists.push({ source: 'openspg_vector', items: vectorHits });
  if (textHits !== null) lists.push({ source: 'openspg_text', items: textHits });
  // Wycofane id odsiewamy PRZED przycięciem do `limit`, żeby martwy węzeł nie zajmował
  // miejsca żywemu — inaczej wycofanie dokumentu obniżałoby liczbę realnych trafień.
  const rankedRaw = rrfFuse(lists);
  const withdrawn = withdrawnIds(ctx.db, rankedRaw.map((f) => f.id));
  const alive = rankedRaw.filter((f) => !withdrawn.has(f.id));
  // Mirror dla WSZYSTKICH żywych kandydatów (nie tylko top-limit): boost dokładnych tokenów
  // musi widzieć treść także tych, których fuzja zepchnęła poniżej limitu.
  const mirror = mirrorLookup(ctx.db, alive.map((f) => f.id));
  const ranked = applyExactTokenBoost(alive, exactTokens, (id) => {
    const m = mirror.get(id);
    return m === undefined ? '' : `${m.title ?? ''}\n${m.content}`;
  });
  const fused = ranked.slice(0, limit);

  const ftsMap = new Map([...ftsExactHits, ...ftsHits].map((h) => [h.id, h]));
  const vectorMap = new Map((vectorHits ?? []).map((h) => [h.id, h]));
  const textMap = new Map((textHits ?? []).map((h) => [h.id, h]));

  let snippetOnly = false;
  const results: RetrievalHit[] = fused.map((f) => {
    const detail = ftsMap.get(f.id) ?? vectorMap.get(f.id) ?? textMap.get(f.id);
    const m = mirror.get(f.id);
    if (m === undefined) snippetOnly = true; // brak pełnej treści w mirrorze — kontekst z samego snippetu
    const namespace = (detail?.namespace !== '' ? detail?.namespace : undefined) ?? m?.namespace ?? '';
    const title = detail?.title ?? m?.title ?? undefined;
    const snippet = detail?.snippet ?? (m ? truncateSnippet(m.content) : '');
    const sourceRef = detail?.sourceRef ?? m?.source_ref ?? undefined;
    // Mirror ma pierwszeństwo nad kanałem: jest lokalny i zawsze kompletny, podczas gdy
    // kanały OpenSPG zwracają tylko te property, o które akurat poprosił zapytujący.
    const docId = m?.doc_id ?? detail?.docId ?? undefined;
    const sectionHeading = m?.section_heading ?? detail?.sectionHeading ?? undefined;
    const vectorScore = vectorMap.get(f.id)?.score;
    return {
      id: f.id,
      namespace,
      snippet,
      score: f.score,
      source: pickSource(f.sources),
      ...(vectorScore !== undefined ? { vectorScore } : {}),
      ...(title !== undefined && title !== null ? { title } : {}),
      ...(sourceRef !== undefined && sourceRef !== null ? { sourceRef } : {}),
      ...(docId !== undefined && docId !== null && docId !== '' ? { docId } : {}),
      ...(sectionHeading !== undefined && sectionHeading !== null && sectionHeading !== ''
        ? { sectionHeading }
        : {}),
    };
  });

  // degraded: żaden kanał OpenSPG nie zadziałał ALBO OpenSPG działał, ale nic nie
  // znalazł, podczas gdy lokalny mirror znalazł (jawny bezpiecznik — §7.5) — plus
  // powody miękkie: wynik bez pełnej treści, przeszukana KB z dirty=1 (mirror może
  // wyprzedzać graf, bo eksport pisze mirror przed buildem).
  const openspgWorked = vectorHits !== null || textHits !== null;
  const openspgItemCount = (vectorHits?.length ?? 0) + (textHits?.length ?? 0);
  const degradedReasons: DegradedReason[] = [];
  if (!openspgWorked) degradedReasons.push('openspg_down');
  else if (openspgItemCount === 0 && ftsHits.length > 0) degradedReasons.push('openspg_no_hits');
  // embed_failed osobno od openspg_down: OpenSPG bywa zdrowy, padł tylko dostawca
  // embeddingów (D8-10) — kokpit nie może pokazywać fałszywej awarii OpenSPG.
  if (embedFailed) degradedReasons.push('embed_failed');
  if (snippetOnly) degradedReasons.push('snippet_only');
  if (namespaces.some((ns) => (kbMap.get(ns)?.dirty ?? 0) === 1)) degradedReasons.push('kb_dirty');

  const activeChannels = lists.length;
  // Kontrakt degraded (bool) bez zmian: twarde powody jak dotychczas; miękkie
  // (snippet_only/kb_dirty) sygnalizowane TYLKO w degradedReasons — konsumenci
  // (cache odpowiedzi, kokpit) czytają degradedReasons, nie sam bool.
  const degraded =
    !openspgWorked || embedFailed || (openspgItemCount === 0 && ftsHits.length > 0);

  const vectorScores = (vectorHits ?? [])
    .map((h) => h.score)
    .filter((s): s is number => typeof s === 'number' && Number.isFinite(s));

  return {
    results,
    degraded,
    degradedReasons,
    activeChannels,
    topVectorScore: vectorScores.length > 0 ? Math.max(...vectorScores) : null,
    lexicalStrict,
    matchedRouting: routing.matched,
    tookMs: Date.now() - started,
    channelMs,
  };
}
