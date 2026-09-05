import type { OpenSpgClient } from './client.js';

/**
 * POST /public/v1/query/spgType — pobranie instancji encji po id (ZWERYFIKOWANE
 * W BOJU 2026-09-04; bez cookie). Autorytatywny stan grafu pod kb_entity_get.
 * Dwie pułapki serwera obsłużone TUTAJ (nigdy nie wypuszczać surowych properties):
 * - `_content_vector`/`_name_vector` (po 1536 floatów) — odcinane,
 * - wartości property z LITERALNYMI cudzysłowami (quirk buildera CSV) — strip.
 */

export interface SpgEntity {
  id: string;
  spgType: string;
  properties: Record<string, string>;
}

export interface QuerySpgTypeParams {
  projectId: number;
  /** Pełna nazwa typu, np. 'StagingSmoke.Chunk'. */
  spgType: string;
  ids: string[];
}

function stripQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

/** Sanityzacja properties: bez pól wektorowych/underscore, wartości bez cudzysłowów. */
export function sanitizeEntityProperties(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('_')) continue; // _content_vector, _name_vector, wewnętrzne
    if (typeof value === 'string') out[key] = stripQuotes(value);
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
  }
  return out;
}

export async function querySpgType(
  client: OpenSpgClient,
  params: QuerySpgTypeParams,
): Promise<SpgEntity[]> {
  const raw = await client.request('/public/v1/query/spgType', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: params.projectId, spgType: params.spgType, ids: params.ids }),
  });
  if (!Array.isArray(raw)) return [];
  const out: SpgEntity[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const id = typeof o['id'] === 'string' ? o['id'] : null;
    if (id === null) continue;
    out.push({
      id,
      spgType: typeof o['spgType'] === 'string' ? o['spgType'] : params.spgType,
      properties: sanitizeEntityProperties(
        typeof o['properties'] === 'object' && o['properties'] !== null
          ? (o['properties'] as Record<string, unknown>)
          : {},
      ),
    });
  }
  return out;
}
