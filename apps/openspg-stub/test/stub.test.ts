import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server.js';

/** Buduje ciało multipart/form-data z jednym plikiem (pole `file`). */
function multipartBody(fileName: string, content: string): { payload: string; contentType: string } {
  const boundary = '----openspgStubTestBoundary';
  const payload = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${fileName}"`,
    'Content-Type: text/csv',
    '',
    content,
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
}

const CSV = [
  'id,name,content,contentPreview',
  'CHUNK_A1_001,Montaż szynoprzewodów,"Maksymalne obciążenie szynoprzewodu trójfazowego wynosi 16 A na fazę.",Maksymalne obciążenie...',
  'CHUNK_A1_002,Dobór barwy światła,"Barwa neutralna 4000K sprawdza się w biurach i kuchniach.",Barwa neutralna...',
  '',
].join('\r\n');

const SCHEMA_DSL = [
  'namespace TestNs',
  '',
  'Chunk(Chunk): EntityType',
  '\tproperties:',
  '\t\tcontent(Treść): Text',
  '\t\t\tindex: TextAndVector',
  '',
  'ReferenceDocument(Dokument referencyjny): EntityType',
  '\tproperties:',
  '\t\tcontent(Treść): Text',
  '',
].join('\n');

interface Envelope<T = unknown> {
  success: boolean;
  result: T;
  errorMsg?: string;
}

describe('openspg-stub: pełny przepływ dev', () => {
  const app = buildServer({ jobMs: 60, uploadDir: mkdtempSync(join(tmpdir(), 'stub-up-')) });
  let projectId = 0;
  let chunkTypeId = 0;
  let fileUrl = '';
  let jobId = 0;

  afterAll(async () => {
    await app.close();
  });

  async function pollJob(id: number): Promise<string> {
    for (let i = 0; i < 200; i++) {
      const res = await app.inject({ method: 'GET', url: `/public/v1/builder/job/get?id=${id}` });
      const body = res.json() as Envelope<{ status: string }>;
      expect(body.success).toBe(true);
      if (['FINISH', 'ERROR', 'SKIP', 'TERMINATE'].includes(body.result.status)) return body.result.status;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('timeout: job nie osiągnął statusu terminalnego');
  }

  it('login zwraca Set-Cookie i kopertę success', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/accounts/login',
      payload: { account: 'openspg', password: 'deadbeef' },
    });
    expect(res.statusCode).toBe(200);
    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();
    expect(String(cookies)).toContain('OPENSPG_SESSION=');
    expect((res.json() as Envelope).success).toBe(true);
  });

  it('tworzy projekt z kolejnym projectId i pokazuje go na liście', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      payload: {
        name: 'Test KB',
        namespace: 'TestNs',
        description: 'projekt testowy',
        visibility: 'PRIVATE',
        tag: 'LOCAL',
        config: { vectorizer: { modelId: 'b87d551dc0ffee00c0ffee00c0ffee00@text-embedding-3-small' } },
      },
    });
    const body = res.json() as Envelope<number>;
    expect(body.success).toBe(true);
    expect(body.result).toBeTypeOf('number');
    projectId = body.result;

    const list = await app.inject({ method: 'GET', url: '/v1/projects/list?keyword=testns&pageNo=1&pageSize=200' });
    const listBody = list.json() as Envelope<{ total: number; data: { namespace: string }[] }>;
    expect(listBody.result.total).toBe(1);
    expect(listBody.result.data[0]?.namespace).toBe('TestNs');

    // duplikat namespace → success:false
    const dup = await app.inject({ method: 'POST', url: '/v1/projects', payload: { namespace: 'TestNs' } });
    expect((dup.json() as Envelope).success).toBe(false);
  });

  it('commit schema → graph zwraca entityTypeDTOList z pełnymi nazwami', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/schemas?projectId=${projectId}`,
      payload: { data: SCHEMA_DSL },
    });
    expect((res.json() as Envelope).success).toBe(true);

    const graph = await app.inject({ method: 'GET', url: `/v1/schemas/graph/${projectId}` });
    const body = graph.json() as Envelope<{ entityTypeDTOList: { id: number; name: string }[] }>;
    const names = body.result.entityTypeDTOList.map((t) => t.name);
    expect(names).toContain('TestNs.Chunk');
    expect(names).toContain('TestNs.ReferenceDocument');
    const chunkType = body.result.entityTypeDTOList.find((t) => t.name === 'TestNs.Chunk');
    expect(chunkType?.id).toBeTypeOf('number');
    chunkTypeId = chunkType?.id ?? 0;

    // ponowny commit (upsert) zachowuje id typów
    await app.inject({ method: 'POST', url: `/v1/schemas?projectId=${projectId}`, payload: { data: SCHEMA_DSL } });
    const graph2 = await app.inject({ method: 'GET', url: `/v1/schemas/graph/${projectId}` });
    const body2 = graph2.json() as Envelope<{ entityTypeDTOList: { id: number; name: string }[] }>;
    expect(body2.result.entityTypeDTOList.find((t) => t.name === 'TestNs.Chunk')?.id).toBe(chunkTypeId);
  });

  it('rejestr modeli: lista zawiera seed, POST /v1/model rejestruje nowy bez echa api_key', async () => {
    const list = await app.inject({ method: 'GET', url: '/v1/model/list/' });
    const models = (list.json() as Envelope<{ model: string; modelType: string }[]>).result;
    expect(models.some((m) => m.modelType === 'embedding')).toBe(true);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/model',
      payload: {
        provider: 'OpenAI',
        visibility: 'PUBLIC_READ',
        name: 'bge-m3',
        config: { api_key: 'sk-super-tajne', base_url: 'http://llm:8000/v1', model: 'bge-m3', modelType: 'embedding' },
      },
    });
    const instanceId = (created.json() as Envelope<string>).result;
    expect(instanceId).toMatch(/^[0-9a-f]{32}$/);

    const list2 = await app.inject({ method: 'GET', url: '/v1/model/list/' });
    expect(list2.body).toContain('bge-m3');
    expect(list2.body).not.toContain('sk-super-tajne'); // sekret nie wraca
  });

  it('upload multipart zwraca pseudo-URL minio', async () => {
    const { payload, contentType } = multipartBody('chunk.csv', CSV);
    const res = await app.inject({
      method: 'POST',
      url: '/public/v1/reasoner/dialog/uploadFile',
      headers: { 'content-type': contentType },
      payload,
    });
    const body = res.json() as Envelope<string>;
    expect(body.success).toBe(true);
    expect(body.result).toMatch(/^http:\/\/release-openspg-minio:9000\/builder\/upload\//);
    fileUrl = body.result;
  });

  it('submit builder joba → INIT/RUNNING → FINISH', async () => {
    const extension = JSON.stringify({
      dataSourceConfig: {
        columns: [
          { name: 'id', index: 0 },
          { name: 'name', index: 1 },
          { name: 'content', index: 2 },
          { name: 'contentPreview', index: 3 },
        ],
        type: 'UPLOAD',
        fileName: 'chunk.csv',
        fileUrl,
        ignoreHeader: true,
        structure: true,
      },
      mappingConfig: {
        mappingType: 'entityMapping',
        filter: [{ s: 'TestNs.Chunk', sId: chunkTypeId, sZhName: 'Chunk', importSchemaCategory: 'ENTITY' }],
        config: [
          {
            mapping: { id: ['id'], name: ['name'], content: ['content'] },
            name: 'Chunk(TestNs.Chunk)',
            id: '1',
          },
        ],
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/public/v1/builder/job/submit',
      payload: {
        projectId,
        createUser: 'openspg',
        jobName: 'TKB Chunk CSV Import',
        type: 'FILE_EXTRACT',
        dataSourceType: 'CSV',
        fileUrl,
        lifeCycle: 'ONCE',
        action: 'UPSERT',
        extension,
      },
    });
    const body = res.json() as Envelope<number>;
    expect(body.success).toBe(true);
    jobId = body.result;
    expect(jobId).toBeTypeOf('number');

    expect(await pollJob(jobId)).toBe('FINISH');
  });

  it('search/text znajduje treść z wgranego CSV', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/public/v1/search/text',
      payload: { queryString: 'szynoprzewodu', labelConstraints: ['TestNs.Chunk'], page: 1, size: 5 },
    });
    const body = res.json() as Envelope<{ docId: string; score: number; fields: Record<string, string> }[]>;
    expect(body.success).toBe(true);
    expect(body.result.length).toBeGreaterThan(0);
    expect(body.result[0]?.docId).toBe('CHUNK_A1_001');
    expect(body.result[0]?.fields['content']).toContain('szynoprzewodu');

    // fraza spoza korpusu → pusto
    const miss = await app.inject({
      method: 'POST',
      url: '/public/v1/search/text',
      payload: { queryString: 'grawitacja kwantowa', page: 1, size: 5 },
    });
    expect((miss.json() as Envelope<unknown[]>).result).toHaveLength(0);
  });

  it('search/vector: deterministyczny ranking po hashu, respektuje topk', async () => {
    const payload = { label: 'TestNs.Chunk', propertyKey: 'contentPreview', queryVector: [0.1, 0.2, 0.3], topk: 1, efSearch: 200 };
    const a = await app.inject({ method: 'POST', url: '/public/v1/search/vector', payload });
    const b = await app.inject({ method: 'POST', url: '/public/v1/search/vector', payload });
    const resA = (a.json() as Envelope<{ docId: string; score: number }[]>).result;
    const resB = (b.json() as Envelope<{ docId: string; score: number }[]>).result;
    expect(resA).toHaveLength(1);
    expect(resA).toEqual(resB); // ten sam wektor → ten sam ranking

    const all = await app.inject({
      method: 'POST',
      url: '/public/v1/search/vector',
      payload: { ...payload, topk: 10 },
    });
    expect((all.json() as Envelope<unknown[]>).result).toHaveLength(2);
  });

  it('job/list wymaga start>=1: start=0 → 500 jak prawdziwy serwer', async () => {
    const bad = await app.inject({
      method: 'GET',
      url: `/public/v1/builder/job/list?projectId=${projectId}&start=0&limit=20`,
    });
    expect(bad.statusCode).toBe(500);
    expect((bad.json() as Envelope).success).toBe(false);

    const good = await app.inject({
      method: 'GET',
      url: `/public/v1/builder/job/list?projectId=${projectId}&start=1&limit=20`,
    });
    expect(good.statusCode).toBe(200);
    const body = good.json() as Envelope<{ total: number; data: { id: number; status: string }[] }>;
    expect(body.result.total).toBeGreaterThan(0);
    expect(body.result.data.some((j) => j.id === jobId)).toBe(true);
  });

  it("fileName zawierający 'fail' kończy job statusem ERROR", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/public/v1/builder/job/submit',
      payload: {
        projectId,
        createUser: 'openspg',
        jobName: 'TKB Fail Import',
        type: 'FILE_EXTRACT',
        dataSourceType: 'CSV',
        fileUrl: 'http://release-openspg-minio:9000/builder/upload/chunk_fail.csv',
        lifeCycle: 'ONCE',
        action: 'UPSERT',
        extension: JSON.stringify({ dataSourceConfig: { fileName: 'chunk_fail.csv' } }),
      },
    });
    const failJobId = (res.json() as Envelope<number>).result;
    expect(await pollJob(failJobId)).toBe('ERROR');
  });
});

describe('openspg-stub: persystencja STUB_STATE_FILE', () => {
  it('projekty przeżywają restart serwera przy tym samym pliku stanu', async () => {
    const stateFile = join(mkdtempSync(join(tmpdir(), 'stub-state-')), 'state.json');
    const first = buildServer({ jobMs: 60, stateFile });
    const created = await first.inject({ method: 'POST', url: '/v1/projects', payload: { namespace: 'PersistNs' } });
    expect((created.json() as Envelope).success).toBe(true);
    await first.close();

    const second = buildServer({ jobMs: 60, stateFile });
    const list = await second.inject({ method: 'GET', url: '/v1/projects/list' });
    const body = list.json() as Envelope<{ data: { namespace: string; id: number }[] }>;
    expect(body.result.data.some((p) => p.namespace === 'PersistNs')).toBe(true);

    // licznik projectId kontynuuje numerację po restarcie
    const next = await second.inject({ method: 'POST', url: '/v1/projects', payload: { namespace: 'PersistNs2' } });
    const firstId = body.result.data.find((p) => p.namespace === 'PersistNs')?.id ?? 0;
    expect((next.json() as Envelope<number>).result).toBe(firstId + 1);
    await second.close();
  });
});
