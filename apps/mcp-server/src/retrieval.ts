import { getKb, searchFts } from '@pomagierkb/shared/db';
import type { Db } from '@pomagierkb/shared/db';
import { rrfFuse, searchText, searchVector } from '@pomagierkb/shared/openspg';
import type { RankedList, SearchHit } from '@pomagierkb/shared/openspg';
import type { ToolCtx } from './tools/types.js';

/**
 * Retrieval hybrydowy (backend-mcp §7.5): trzy kanały równolegle
 *  (a) FTS5 trigram na chunks_mirror (lokalny, synchroniczny — polska fleksja),
 *  (b) OpenSPG search/vector (embed zapytania po naszej stronie),
 *  (c) OpenSPG search/text,
 * fuzja RRF (k=60), dedup po id. Fallback FTS5 jest bezpiecznikiem, nie substytutem
 * OpenSPG — degraded:true gdy działał tylko FTS5 (albo OpenSPG nic nie znalazł,
 * a mirror tak).
 */

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
  namespaces?: string[];
  limit?: number;
  mode?: RetrievalMode;
}

export interface RetrievalResult {
  results: RetrievalHit[];
  degraded: boolean;
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

/** Namespace z id w konwencji 'Ns:Typ:hash' — tylko gdy prefiks jest znanym namespace. */
function deriveNamespace(id: string, known: Set<string>): string | undefined {
  const prefix = id.split(':')[0];
  return prefix !== undefined && known.has(prefix) ? prefix : undefined;
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
  ctx: ToolCtx,
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

export async function hybridSearch(ctx: ToolCtx, params: HybridSearchParams): Promise<RetrievalResult> {
  const started = Date.now();
  const limit = Math.min(Math.max(params.limit ?? 8, 1), 20);
  const mode: RetrievalMode = params.mode ?? 'hybrid';
  const allowed = new Set(ctx.allowedNamespaces);
  const namespaces = (
    params.namespaces && params.namespaces.length > 0 ? params.namespaces : ctx.allowedNamespaces
  ).filter((ns) => allowed.has(ns));
  if (namespaces.length === 0) {
    return { results: [], degraded: true, tookMs: Date.now() - started };
  }
  const nsSet = new Set(namespaces);

  // (a) FTS5 — synchroniczny (better-sqlite3), timeout nie dotyczy; błąd → pusty kanał.
  let ftsHits: ChannelHit[] = [];
  try {
    ftsHits = searchFts(ctx.db, params.query, namespaces, limit).map((r) => ({
      id: r.id,
      namespace: r.namespace,
      snippet: r.snippet,
      ...(r.title !== null ? { title: r.title } : {}),
    }));
  } catch (err) {
    ctx.log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'retrieval: FTS5 zawiódł',
    );
  }

  // (b)+(c) OpenSPG — równolegle, każdy z własnym timeoutem 5 s.
  const openspg = ctx.openspg;
  const llm = ctx.llm;
  const vectorNamespaces = namespaces.filter((ns) => (getKb(ctx.db, ns)?.embedding_model ?? '') !== '');
  const vectorEnabled = mode !== 'text' && openspg !== null && llm !== null && vectorNamespaces.length > 0;
  const textEnabled = mode !== 'vector' && openspg !== null;

  const [vectorHits, textHits] = await Promise.all([
    vectorEnabled && openspg && llm
      ? runChannel(ctx, 'openspg_vector', async () => {
          const [queryVector] = await llm.embed([params.query]);
          if (!queryVector || queryVector.length === 0) {
            throw new Error('embed zapytania zwrócił pusty wektor');
          }
          const scored: { hit: SearchHit; ns: string }[] = [];
          for (const ns of vectorNamespaces) {
            const res = await searchVector(openspg, {
              label: `${ns}.Chunk`,
              propertyKey: 'content',
              queryVector,
              topk: limit,
            });
            for (const hit of res.items) scored.push({ hit, ns });
          }
          scored.sort((a, b) => b.hit.score - a.hit.score);
          return scored.slice(0, limit).map(({ hit, ns }) => toChannelHit(hit, ns));
        })
      : Promise.resolve(null),
    textEnabled && openspg
      ? runChannel(ctx, 'openspg_text', async () => {
          const res = await searchText(openspg, {
            queryString: params.query,
            labelConstraints: namespaces.flatMap((ns) => [`${ns}.Chunk`, `${ns}.ReferenceDocument`]),
            page: 1,
            size: limit,
          });
          const items = [...res.items].sort((a, b) => b.score - a.score).slice(0, limit);
          return items.map((hit) => toChannelHit(hit, deriveNamespace(hit.id, nsSet) ?? ''));
        })
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

  const results: RetrievalHit[] = fused.map((f) => {
    const detail = ftsMap.get(f.id) ?? vectorMap.get(f.id) ?? textMap.get(f.id);
    const m = mirror.get(f.id);
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
  // znalazł, podczas gdy lokalny mirror znalazł (jawny bezpiecznik — §7.5).
  const openspgWorked = vectorHits !== null || textHits !== null;
  const openspgItemCount = (vectorHits?.length ?? 0) + (textHits?.length ?? 0);
  const degraded = !openspgWorked || (openspgItemCount === 0 && ftsHits.length > 0);

  return { results, degraded, tookMs: Date.now() - started };
}
