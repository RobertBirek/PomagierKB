import { describe, expect, it } from 'vitest';
import { OpenSpgClient } from '../src/openspg/client.js';
import { ensureEmbeddingModel, listModels } from '../src/openspg/models.js';
import {
  commitSchema, createProject, findProjectByNamespace, getSchemaGraph, listProjects,
} from '../src/openspg/projects.js';
import { fixture, jsonResponse, loginResponse, makeMockFetch, type MockHandler } from './helpers/openspg-mock.js';

function makeClient(handler: MockHandler) {
  const { impl, calls } = makeMockFetch((path, init, call) => {
    if (path === '/v1/accounts/login') return loginResponse();
    return handler(path, init, call);
  });
  const client = new OpenSpgClient({
    baseUrl: 'http://release-openspg-server:8887',
    account: 'openspg',
    password: 'openspg@kag',
    fetchImpl: impl,
  });
  return { client, calls };
}

describe('projects', () => {
  it('listProjects woła list z pełnym query i normalizuje result.data', async () => {
    const { client, calls } = makeClient(() => jsonResponse(fixture('projects-list.json')));
    const projects = await listProjects(client);
    expect(calls[1]!.path).toBe('/v1/projects/list?isOwner=false&keyword=&pageNo=1&pageSize=200&appId=0');
    expect(projects.map((p) => p.namespace)).toEqual(['LightingDocs', 'ServiceOps']);
  });

  it('findProjectByNamespace znajduje projekt (idempotencja provisioningu)', async () => {
    const { client } = makeClient(() => jsonResponse(fixture('projects-list.json')));
    expect((await findProjectByNamespace(client, 'LightingDocs'))?.id).toBe(3);
    expect(await findProjectByNamespace(client, 'Nope')).toBeUndefined();
  });

  it('createProject wysyła visibility/tag/config.vectorizer i zwraca projectId z result', async () => {
    const { client, calls } = makeClient(() => jsonResponse({ success: true, result: 7 }));
    const id = await createProject(client, {
      name: 'Testowa KB',
      namespace: 'TestKb',
      description: 'opis',
      vectorizerModelId: 'b87d551d4ba14909907c6e29218fa011@text-embedding-3-small',
    });
    expect(id).toBe(7);
    expect(calls[1]!.path).toBe('/v1/projects');
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({
      name: 'Testowa KB',
      namespace: 'TestKb',
      description: 'opis',
      visibility: 'PRIVATE',
      tag: 'LOCAL',
      config: { vectorizer: { modelId: 'b87d551d4ba14909907c6e29218fa011@text-embedding-3-small' } },
    });
  });

  it('commitSchema robi upsert całej treści schematu pod ?projectId=', async () => {
    const { client, calls } = makeClient(() => jsonResponse({ success: true, result: true }));
    await commitSchema(client, 7, 'namespace TestKb\n\nChunk(Chunk): EntityType\n');
    expect(calls[1]!.path).toBe('/v1/schemas?projectId=7');
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({
      data: 'namespace TestKb\n\nChunk(Chunk): EntityType\n',
    });
  });

  it('getSchemaGraph mapuje entityTypeDTOList na nazwy długie ORAZ krótkie', async () => {
    const { client } = makeClient(() => jsonResponse(fixture('schemas-graph.json')));
    const map = await getSchemaGraph(client, 3);
    expect(map.get('LightingDocs.Chunk')).toBe(118);
    expect(map.get('Chunk')).toBe(118);
    expect(map.get('LightingDocs.ReferenceDocument')).toBe(117);
    expect(map.get('ReferenceDocument')).toBe(117);
    expect(map.get('Topic')).toBe(116);
    expect(map.size).toBe(8);
  });
});

describe('models', () => {
  it('listModels spłaszcza grupy do wpisów modeli', async () => {
    const { client } = makeClient(() => jsonResponse(fixture('model-list-with-embedding.json')));
    const models = await listModels(client);
    expect(models.map((m) => m.model)).toEqual(['gpt-4o-mini', 'text-embedding-3-small']);
  });

  it('ensureEmbeddingModel zwraca istniejący modelId bez rejestracji', async () => {
    const { client, calls } = makeClient(() => jsonResponse(fixture('model-list-with-embedding.json')));
    const modelId = await ensureEmbeddingModel(client, {
      model: 'text-embedding-3-small', apiKey: 'sk-test', baseUrl: 'https://api.openai.com/v1',
    });
    expect(modelId).toBe('b87d551d4ba14909907c6e29218fa011@text-embedding-3-small');
    expect(calls.filter((c) => c.path === '/v1/model' && c.init?.method === 'POST')).toHaveLength(0);
  });

  it('brak modelu → POST /v1/model i ponowny list; wynik z drugiego listowania', async () => {
    let lists = 0;
    const { client, calls } = makeClient((path, init) => {
      if (path === '/v1/model' && init?.method === 'POST') return jsonResponse({ success: true, result: true });
      lists += 1;
      return jsonResponse(fixture(lists === 1 ? 'model-list.json' : 'model-list-with-embedding.json'));
    });
    const modelId = await ensureEmbeddingModel(client, {
      model: 'text-embedding-3-small', apiKey: 'sk-test', baseUrl: 'https://api.openai.com/v1',
    });
    expect(modelId).toBe('b87d551d4ba14909907c6e29218fa011@text-embedding-3-small');
    const post = calls.find((c) => c.path === '/v1/model');
    expect(JSON.parse(String(post!.init?.body))).toEqual({
      provider: 'OpenAI',
      visibility: 'PUBLIC_READ',
      name: 'text-embedding-3-small',
      config: {
        api_key: 'sk-test',
        base_url: 'https://api.openai.com/v1',
        model: 'text-embedding-3-small',
        modelType: 'embedding',
        customize: {},
      },
    });
  });
});
