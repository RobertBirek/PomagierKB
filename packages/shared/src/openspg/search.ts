import type { OpenSpgClient } from './client.js';

/**
 * Search OpenSPG — payloady NIEZWERYFIKOWANE W BOJU (SKILL.md), stąd klient defensywny:
 * normalizator wielu kształtów odpowiedzi, sonda zgodności, warn przy nieznanym kształcie.
 */

export type SearchShape = 'success_result' | 'data' | 'array' | 'unknown';

export interface SearchHit {
  id: string;
  score: number;
  fields: Record<string, unknown>;
}

export interface NormalizedSearch {
  items: SearchHit[];
  shape: SearchShape;
}

function toList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const data = (value as { data?: unknown }).data;
    if (Array.isArray(data)) return data;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function mapHit(el: unknown): SearchHit | null {
  const o = asRecord(el);
  if (!o) return null;
  const node = asRecord(o['node']);
  const rawId = o['docId'] ?? o['id'] ?? node?.['id'];
  if (rawId === undefined || rawId === null || rawId === '') return null;
  const rawScore = o['score'] ?? node?.['score'];
  const score = typeof rawScore === 'number' && Number.isFinite(rawScore) ? rawScore : Number(rawScore) || 0;
  const fields = asRecord(o['fields']) ?? asRecord(o['properties']) ?? asRecord(node?.['properties']) ?? {};
  return { id: String(rawId), score, fields };
}

/**
 * Akceptuje {success:true,result:[...]} | {data:[...]} | goły array; elementy mapowane
 * elastycznie (id z docId|id|node.id; pola z fields|properties|node.properties).
 * Nieznany kształt → console.warn z obciętym surowym body + pusty wynik.
 */
export function normalizeSearchResponse(raw: unknown): NormalizedSearch {
  let shape: SearchShape = 'unknown';
  let list: unknown[] | null = null;
  if (Array.isArray(raw)) {
    shape = 'array';
    list = raw;
  } else {
    const o = asRecord(raw);
    if (o) {
      if (o['success'] === true) {
        list = toList(o['result']);
        if (list) shape = 'success_result';
      } else if ('data' in o) {
        list = toList(o['data']);
        if (list) shape = 'data';
      }
    }
  }
  if (!list || shape === 'unknown') {
    let preview: string;
    try {
      preview = JSON.stringify(raw) ?? String(raw);
    } catch {
      preview = String(raw);
    }
    console.warn('[openspg] nieznany kształt odpowiedzi search:', preview.slice(0, 500));
    return { items: [], shape: 'unknown' };
  }
  return { items: list.map(mapHit).filter((h): h is SearchHit => h !== null), shape };
}

export interface SearchTextParams {
  /** WYMAGANE przez serwer (TextSearchRequest.projectId — zdekompilowane 2026-09-02). */
  projectId: number;
  queryString: string;
  labelConstraints: string[]; // np. ['Ns.Chunk','Ns.ReferenceDocument']
  page?: number;
  /** Limit wyników — pole nazywa się topk (NIE size). */
  topk?: number;
}

/** POST /public/v1/search/text */
export async function searchText(
  client: OpenSpgClient,
  params: SearchTextParams,
): Promise<NormalizedSearch> {
  const raw = await client.request('/public/v1/search/text', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: params.projectId,
      queryString: params.queryString,
      labelConstraints: params.labelConstraints,
      page: params.page ?? 1,
      topk: params.topk ?? 10,
    }),
  });
  return normalizeSearchResponse(raw);
}

export interface SearchVectorParams {
  /** WYMAGANE przez serwer (VectorSearchRequest.projectId). */
  projectId: number;
  label: string;       // np. 'Ns.Chunk'
  propertyKey: string; // np. 'contentPreview'
  queryVector: number[];
  topk: number;
  efSearch?: number;
}

/** POST /public/v1/search/vector (wektor zapytania liczymy SAMI modelem vectorizera projektu). */
export async function searchVector(
  client: OpenSpgClient,
  params: SearchVectorParams,
): Promise<NormalizedSearch> {
  const raw = await client.request('/public/v1/search/vector', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: params.projectId,
      label: params.label,
      propertyKey: params.propertyKey,
      queryVector: params.queryVector,
      topk: params.topk,
      efSearch: params.efSearch ?? 200,
    }),
  });
  return normalizeSearchResponse(raw);
}

export interface SearchProbeResult {
  textOk: boolean;
  vectorOk: boolean;
  detectedShape: SearchShape;
}

/**
 * Sonda zgodności (start + cyklicznie): testowe wywołania obu endpointów na namespace.
 * Bez queryVector w opts wysyła krótki wektor zerowy — serwer może go odrzucić przez
 * niezgodny wymiar, wtedy vectorOk=false (uczciwa degradacja do text-only).
 */
export async function probeSearch(
  client: OpenSpgClient,
  namespace: string,
  opts: { queryVector?: number[]; projectId?: number } = {},
): Promise<SearchProbeResult> {
  const projectId = opts.projectId ?? 0;
  let textOk = false;
  let vectorOk = false;
  let detectedShape: SearchShape = 'unknown';
  try {
    const r = await searchText(client, {
      projectId,
      queryString: 'test',
      labelConstraints: [`${namespace}.Chunk`],
      page: 1,
      topk: 1,
    });
    textOk = r.shape !== 'unknown';
    if (textOk) detectedShape = r.shape;
  } catch {
    textOk = false;
  }
  try {
    const r = await searchVector(client, {
      projectId,
      label: `${namespace}.Chunk`,
      // 'content' = pole faktycznie indeksowane TextAndVector (kanał produkcyjny);
      // 'contentPreview' jest tylko Text — sonda na nim była trwale czerwona.
      propertyKey: 'content',
      queryVector: opts.queryVector ?? new Array<number>(8).fill(0),
      topk: 1,
    });
    vectorOk = r.shape !== 'unknown';
    if (detectedShape === 'unknown' && vectorOk) detectedShape = r.shape;
  } catch {
    vectorOk = false;
  }
  return { textOk, vectorOk, detectedShape };
}

export interface RankedList {
  source: string; // np. 'openspg_text' | 'openspg_vector'
  items: Array<{ id: string }>;
}

export interface FusedHit {
  id: string;
  score: number;
  sources: string[];
}

/**
 * Reciprocal Rank Fusion: score = Σ 1/(k + rank), rank 1-based per lista; dedup po id
 * (także w obrębie jednej listy — liczy się pierwsze wystąpienie). Wynik deterministyczny:
 * sort po score malejąco, remis rozstrzyga id.
 */
export function rrfFuse(lists: RankedList[], opts: { k?: number } = {}): FusedHit[] {
  const k = opts.k ?? 60;
  const fused = new Map<string, FusedHit>();
  for (const list of lists) {
    const seen = new Set<string>();
    list.items.forEach((item, i) => {
      if (!item.id || seen.has(item.id)) return;
      seen.add(item.id);
      const hit = fused.get(item.id) ?? { id: item.id, score: 0, sources: [] };
      hit.score += 1 / (k + i + 1);
      if (!hit.sources.includes(list.source)) hit.sources.push(list.source);
      fused.set(item.id, hit);
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
