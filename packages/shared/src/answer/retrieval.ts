import type { Db } from '../db/index.js';
import { listKbs, searchFts, type KbRow } from '../db/index.js';
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

export type RetrievalSource = 'fallback_fts' | 'openspg_vector' | 'openspg_text';
export type RetrievalMode = 'hybrid' | 'text' | 'vector';

export interface RetrievalHit {
  id: string;
  namespace: string;
  title?: string;
  snippet: string;
  score: number;
  source: RetrievalSource;
  sourceRef?: string;
}

export interface HybridSearchParams {
  query: string;
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
  | 'snippet_only' // któryś wynik bez pełnej treści (tylko 300-znakowy snippet)
  | 'kb_dirty'; // przeszukana KB ma zmiany nie wbudowane w graf (mirror może wyprzedzać)

export interface RetrievalResult {
  results: RetrievalHit[];
  degraded: boolean;
  degradedReasons: DegradedReason[];
  /** Liczba kanałów, które realnie weszły do fuzji (normalizacja topScore w answer). */
  activeChannels: number;
  /** Namespace'y wzmocnione przez routing hints (kb_registry.routing_keywords). */
  matchedRouting: string[];
  tookMs: number;
}

const CHANNEL_TIMEOUT_MS = 5000;
const SNIPPET_MAX = 300;

/** Wewnętrzny, znormalizowany hit pojedynczego kanału (kolejność = ranking). */
interface ChannelHit {
  id: string;
  namespace: string;
  title?: string;
  snippet?: string;
  sourceRef?: string;
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

function toChannelHit(hit: SearchHit, namespace: string): ChannelHit {
  const title = firstString(hit.fields, ['title', 'name']);
  const content = firstString(hit.fields, [
    'content',
    'contentPreview',
    'descriptionPreview',
    'description',
    'summary',
  ]);
  const sourceRef = firstString(hit.fields, ['sourceRef', 'source_ref', 'sourceUrl', 'url']);
  return {
    id: hit.id,
    namespace,
    ...(title !== undefined ? { title } : {}),
    ...(content !== undefined ? { snippet: truncateSnippet(content) } : {}),
    ...(sourceRef !== undefined ? { sourceRef } : {}),
  };
}

/**
 * Kanał async z timeoutem 5 s: błąd/timeout → null (kanał "nie zadziałał"),
 * nigdy nie wywraca całego retrievalu.
 */
async function runChannel(
  ctx: AnswerCtx,
  name: string,
  run: () => Promise<ChannelHit[]>,
): Promise<ChannelHit[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), CHANNEL_TIMEOUT_MS);
  });
  try {
    const value = await Promise.race([run(), timeout]);
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
  }
}

interface MirrorRow {
  id: string;
  namespace: string;
  title: string | null;
  content: string;
  source_ref: string | null;
}

/** Wzbogacenie finalnych wyników o dane z chunks_mirror (tytuł/snippet/sourceRef). */
function mirrorLookup(db: Db, ids: string[]): Map<string, MirrorRow> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, namespace, title, content, source_ref FROM chunks_mirror WHERE id IN (${placeholders})`,
    )
    .all(...ids) as MirrorRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

/** Priorytet oznaczenia źródła: OpenSPG przed fallbackiem lokalnym. */
function pickSource(sources: string[]): RetrievalSource {
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
      matchedRouting: [],
      tookMs: Date.now() - started,
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
  const fusePerNamespace = (byNs: Map<string, ChannelHit[]>): ChannelHit[] => {
    if (byNs.size <= 1) {
      const only = [...byNs.values()][0] ?? [];
      return only.slice(0, limit);
    }
    const lists: RankedList[] = [...byNs.entries()].map(([ns, items]) => ({
      source: ns,
      items,
      weight: routing.weights.get(ns) ?? 1,
    }));
    const byId = new Map<string, ChannelHit>();
    for (const items of byNs.values()) for (const h of items) if (!byId.has(h.id)) byId.set(h.id, h);
    return rrfFuse(lists)
      .slice(0, limit)
      .map((f) => byId.get(f.id))
      .filter((h): h is ChannelHit => h !== undefined);
  };

  // (a) FTS5 — synchroniczny (better-sqlite3), timeout nie dotyczy; błąd → pusty kanał.
  let ftsHits: ChannelHit[] = [];
  try {
    const raw = searchFts(ctx.db, params.query, namespaces, limit).map((r) => ({
      id: r.id,
      namespace: r.namespace,
      snippet: r.snippet,
      ...(r.title !== null ? { title: r.title } : {}),
    }));
    // Re-ważenie routingiem także w kanale lokalnym (spójnie z kanałami OpenSPG).
    const byNs = new Map<string, ChannelHit[]>();
    for (const h of raw) {
      const list = byNs.get(h.namespace);
      if (list === undefined) byNs.set(h.namespace, [h]);
      else list.push(h);
    }
    ftsHits = fusePerNamespace(byNs);
  } catch (err) {
    ctx.log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'retrieval: FTS5 zawiódł',
    );
  }

  // (b)+(c) OpenSPG — równolegle, każdy z własnym timeoutem 5 s i breakerem
  // ('openspg' w tabeli breakers: otwarty → kanał od razu null, kokpit widzi stan).
  const openspg = ctx.openspg;
  const llm = ctx.llm;
  const vectorNamespaces = namespaces.filter((ns) => (kbMap.get(ns)?.embedding_model ?? '') !== '');
  const vectorEnabled = mode !== 'text' && openspg !== null && llm !== null && vectorNamespaces.length > 0;
  const textEnabled = mode !== 'vector' && openspg !== null;

  const [vectorHits, textHits] = await Promise.all([
    vectorEnabled && openspg && llm
      ? runChannel(ctx, 'openspg_vector', () =>
          withBreaker(ctx.db, 'openspg', async () => {
            const [queryVector] = await llm.embed([params.query]);
            if (!queryVector || queryVector.length === 0) {
              throw new Error('embed zapytania zwrócił pusty wektor');
            }
            const byNs = new Map<string, ChannelHit[]>();
            for (const ns of vectorNamespaces) {
              const projectId = kbMap.get(ns)?.project_id;
              if (projectId === null || projectId === undefined) continue; // KB bez provisioningu
              const res = await searchVector(openspg, {
                projectId,
                label: `${ns}.Chunk`,
                propertyKey: 'content',
                queryVector,
                topk: limit,
              });
              // kolejność per KB wg score (porównywalne WEWNĄTRZ projektu)
              byNs.set(ns, [...res.items].sort((a, b) => b.score - a.score).map((h) => toChannelHit(h, ns)));
            }
            return fusePerNamespace(byNs);
          }),
        )
      : Promise.resolve(null),
    textEnabled && openspg
      ? runChannel(ctx, 'openspg_text', () =>
          withBreaker(ctx.db, 'openspg', async () => {
            // TextSearchRequest wymaga projectId — wołamy per namespace i scalamy;
            // ns znany z pętli (id eksportera to DOC_/CHUNK_ — nie niesie namespace).
            const byNs = new Map<string, ChannelHit[]>();
            for (const ns of namespaces) {
              const projectId = kbMap.get(ns)?.project_id;
              if (projectId === null || projectId === undefined) continue;
              const res = await searchText(openspg, {
                projectId,
                queryString: params.query,
                labelConstraints: [`${ns}.Chunk`, `${ns}.ReferenceDocument`],
                page: 1,
                topk: limit,
              });
              byNs.set(ns, [...res.items].sort((a, b) => b.score - a.score).map((h) => toChannelHit(h, ns)));
            }
            return fusePerNamespace(byNs);
          }),
        )
      : Promise.resolve(null),
  ]);

  // Fuzja RRF + dedup po id (rrfFuse deduplikuje w obrębie i między listami).
  const lists: RankedList[] = [];
  if (ftsHits.length > 0) lists.push({ source: 'fallback_fts', items: ftsHits });
  if (vectorHits !== null) lists.push({ source: 'openspg_vector', items: vectorHits });
  if (textHits !== null) lists.push({ source: 'openspg_text', items: textHits });
  const fused = rrfFuse(lists).slice(0, limit);

  const ftsMap = new Map(ftsHits.map((h) => [h.id, h]));
  const vectorMap = new Map((vectorHits ?? []).map((h) => [h.id, h]));
  const textMap = new Map((textHits ?? []).map((h) => [h.id, h]));
  const mirror = mirrorLookup(ctx.db, fused.map((f) => f.id));

  let snippetOnly = false;
  const results: RetrievalHit[] = fused.map((f) => {
    const detail = ftsMap.get(f.id) ?? vectorMap.get(f.id) ?? textMap.get(f.id);
    const m = mirror.get(f.id);
    if (m === undefined) snippetOnly = true; // brak pełnej treści w mirrorze — kontekst z samego snippetu
    const namespace = (detail?.namespace !== '' ? detail?.namespace : undefined) ?? m?.namespace ?? '';
    const title = detail?.title ?? m?.title ?? undefined;
    const snippet = detail?.snippet ?? (m ? truncateSnippet(m.content) : '');
    const sourceRef = detail?.sourceRef ?? m?.source_ref ?? undefined;
    return {
      id: f.id,
      namespace,
      snippet,
      score: f.score,
      source: pickSource(f.sources),
      ...(title !== undefined && title !== null ? { title } : {}),
      ...(sourceRef !== undefined && sourceRef !== null ? { sourceRef } : {}),
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
  if (snippetOnly) degradedReasons.push('snippet_only');
  if (namespaces.some((ns) => (kbMap.get(ns)?.dirty ?? 0) === 1)) degradedReasons.push('kb_dirty');

  const activeChannels = lists.length;
  // Kontrakt degraded (bool) bez zmian: twarde powody jak dotychczas; miękkie
  // (snippet_only/kb_dirty) sygnalizowane TYLKO w degradedReasons.
  const degraded = !openspgWorked || (openspgItemCount === 0 && ftsHits.length > 0);

  return {
    results,
    degraded,
    degradedReasons,
    activeChannels,
    matchedRouting: routing.matched,
    tookMs: Date.now() - started,
  };
}
