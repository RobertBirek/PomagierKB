import { UpstreamError } from '../errors.js';
import type { OpenSpgClient } from './client.js';

/** Wpis rejestru modeli serwera OpenSPG (spłaszczony z grup provider→model[]). */
export interface ModelEntry {
  modelId: string;   // '<instanceId>@<model>', np. 'b87d...@text-embedding-3-small'
  model: string;
  modelType: string; // 'embedding' | 'chat' | ...
  [key: string]: unknown;
}

/** GET /v1/model/list/ → spłaszczona lista wpisów ze wszystkich grup. */
export async function listModels(client: OpenSpgClient): Promise<ModelEntry[]> {
  const result = await client.requestResult('/v1/model/list/');
  const groups = Array.isArray(result) ? result : [];
  const entries: ModelEntry[] = [];
  for (const g of groups) {
    const models = (g as { model?: unknown }).model;
    if (Array.isArray(models)) {
      for (const m of models) {
        if (m && typeof m === 'object') entries.push(m as ModelEntry);
      }
    }
  }
  return entries;
}

export interface EnsureEmbeddingModelParams {
  model: string;   // np. 'text-embedding-3-small'
  apiKey: string;
  baseUrl: string; // base_url API embeddings (OpenAI-compatible)
}

/**
 * Idempotentnie zapewnia model embeddingu w rejestrze serwera i zwraca jego modelId
 * ('<instance>@<model>') — to idzie do config.vectorizer.modelId projektu.
 */
export async function ensureEmbeddingModel(
  client: OpenSpgClient,
  params: EnsureEmbeddingModelParams,
): Promise<string> {
  const find = (entries: ModelEntry[]): ModelEntry | undefined =>
    entries.find((e) => e.model === params.model && e.modelType === 'embedding');

  let entry = find(await listModels(client));
  if (!entry) {
    await client.postJson('/v1/model', {
      provider: 'OpenAI',
      visibility: 'PUBLIC_READ',
      name: params.model,
      config: {
        api_key: params.apiKey,
        base_url: params.baseUrl,
        model: params.model,
        modelType: 'embedding',
        customize: {},
      },
    });
    entry = find(await listModels(client));
  }
  if (!entry || typeof entry.modelId !== 'string' || entry.modelId === '') {
    throw new UpstreamError('openspg', '/v1/model/list/', undefined,
      `model embeddingu '${params.model}' nie pojawił się w rejestrze po rejestracji`);
  }
  return entry.modelId;
}
