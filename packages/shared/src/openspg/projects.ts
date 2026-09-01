import { UpstreamError } from '../errors.js';
import type { OpenSpgClient } from './client.js';

export interface OpenSpgProject {
  id: number;
  name: string;
  namespace: string;
  [key: string]: unknown;
}

/** GET /v1/projects/list — result bywa tablicą albo {data:[...]}; normalizujemy do tablicy. */
export async function listProjects(client: OpenSpgClient): Promise<OpenSpgProject[]> {
  const result = await client.requestResult(
    '/v1/projects/list?isOwner=false&keyword=&pageNo=1&pageSize=200&appId=0',
  );
  const list = Array.isArray(result)
    ? result
    : result && typeof result === 'object' && Array.isArray((result as { data?: unknown }).data)
      ? ((result as { data: unknown[] }).data)
      : [];
  return list.filter((p): p is OpenSpgProject => !!p && typeof p === 'object');
}

/** Idempotencja provisioningu: szukanie projektu po namespace. */
export async function findProjectByNamespace(
  client: OpenSpgClient,
  namespace: string,
): Promise<OpenSpgProject | undefined> {
  return (await listProjects(client)).find((p) => p.namespace === namespace);
}

export interface CreateProjectParams {
  name: string;
  namespace: string;
  description: string;
  vectorizerModelId: string; // '<instance>@<model>' z ensureEmbeddingModel — NIEZMIENIALNY po utworzeniu
}

/** POST /v1/projects → projectId (liczba). */
export async function createProject(
  client: OpenSpgClient,
  params: CreateProjectParams,
): Promise<number> {
  const result = await client.postJson('/v1/projects', {
    name: params.name,
    namespace: params.namespace,
    description: params.description,
    visibility: 'PRIVATE',
    tag: 'LOCAL',
    config: { vectorizer: { modelId: params.vectorizerModelId } },
  });
  const id = typeof result === 'object' && result !== null
    ? Number((result as Record<string, unknown>)['id'])
    : Number(result);
  if (!Number.isFinite(id)) {
    throw new UpstreamError('openspg', '/v1/projects', undefined, 'nieoczekiwany wynik tworzenia projektu (brak projectId)');
  }
  return id;
}

/** POST /v1/schemas?projectId=N — upsert całej treści pliku .schema (także dla istniejącego projektu). */
export async function commitSchema(
  client: OpenSpgClient,
  projectId: number,
  schemaText: string,
): Promise<void> {
  await client.postJson(`/v1/schemas?projectId=${projectId}`, { data: schemaText });
}

/**
 * GET /v1/schemas/graph/{projectId} → Map nazwa→entityTypeId.
 * Klucze: długie ('Ns.Entity') ORAZ krótkie (część po ostatniej kropce).
 */
export async function getSchemaGraph(
  client: OpenSpgClient,
  projectId: number,
): Promise<Map<string, number>> {
  const result = await client.requestResult(`/v1/schemas/graph/${projectId}`);
  const dtos = result && typeof result === 'object'
    ? (result as { entityTypeDTOList?: unknown }).entityTypeDTOList
    : undefined;
  if (!Array.isArray(dtos)) {
    throw new UpstreamError('openspg', `/v1/schemas/graph/${projectId}`, undefined,
      'brak entityTypeDTOList w odpowiedzi schemas/graph');
  }
  const map = new Map<string, number>();
  for (const dto of dtos) {
    if (!dto || typeof dto !== 'object') continue;
    const o = dto as Record<string, unknown>;
    const name = o['name'];
    const id = Number(o['id']);
    if (typeof name !== 'string' || name === '' || !Number.isFinite(id)) continue;
    map.set(name, id);
    const short = name.slice(name.lastIndexOf('.') + 1);
    if (short !== name && !map.has(short)) map.set(short, id);
  }
  return map;
}
