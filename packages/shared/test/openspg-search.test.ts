import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenSpgClient } from '../src/openspg/client.js';
import { normalizeSearchResponse, probeSearch, rrfFuse, searchText, searchVector } from '../src/openspg/search.js';
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

afterEach(() => vi.restoreAllMocks());

describe('normalizeSearchResponse', () => {
  it('kształt {success:true,result:[...]} — id z docId, pola z fields', () => {
    const out = normalizeSearchResponse(fixture('search-text-success-result.json'));
    expect(out.shape).toBe('success_result');
    expect(out.items).toHaveLength(2);
    expect(out.items[0]).toEqual({
      id: 'LightingDocs:Chunk:9f2c11ab',
      score: 18.34,
      fields: {
        name: 'Montaż szynoprzewodów',
        contentPreview: 'Maksymalne obciążenie szyny 3F wynosi 16 A na fazę...',
        sourceUrl: 'https://example.com/karta.pdf',
      },
    });
  });

  it('kształt {data:[...]} — id z id, pola z properties', () => {
    const out = normalizeSearchResponse(fixture('search-data.json'));
    expect(out.shape).toBe('data');
    expect(out.items).toHaveLength(1);
    expect(out.items[0]!.id).toBe('LightingDocs:Chunk:9f2c11ab');
    expect(out.items[0]!.score).toBe(0.83);
    expect(out.items[0]!.fields['name']).toBe('Montaż szynoprzewodów');
  });

  it('goły array — id z node.id, pola z node.properties', () => {
    const out = normalizeSearchResponse(fixture('search-array.json'));
    expect(out.shape).toBe('array');
    expect(out.items.map((i) => i.id)).toEqual([
      'LightingDocs:Chunk:9f2c11ab',
      'LightingDocs:Chunk:41bb9900',
    ]);
    expect(out.items[1]!.fields['name']).toBe('Sterowanie DALI');
  });

  it('nieznany kształt → console.warn z obciętym surowym body + pusty wynik', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = normalizeSearchResponse({ weird: 'x'.repeat(2000) });
    expect(out).toEqual({ items: [], shape: 'unknown' });
    expect(warn).toHaveBeenCalledTimes(1);
    const preview = warn.mock.calls[0]![1] as string;
    expect(preview.length).toBeLessThanOrEqual(500);
  });

  it('elementy bez id są pomijane, brak score → 0', () => {
    const out = normalizeSearchResponse([{ id: 'a' }, { properties: { name: 'bez id' } }]);
    expect(out.items).toEqual([{ id: 'a', score: 0, fields: {} }]);
  });
});

describe('searchText / searchVector', () => {
  it('searchText wysyła {projectId, queryString, labelConstraints, page, topk} i normalizuje', async () => {
    const { client, calls } = makeClient(() => jsonResponse(fixture('search-text-success-result.json')));
    const out = await searchText(client, {
      projectId: 7,
      queryString: 'obciążenie szyny',
      labelConstraints: ['LightingDocs.Chunk', 'LightingDocs.ReferenceDocument'],
      topk: 8,
    });
    expect(calls[1]!.path).toBe('/public/v1/search/text');
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({
      projectId: 7,
      queryString: 'obciążenie szyny',
      labelConstraints: ['LightingDocs.Chunk', 'LightingDocs.ReferenceDocument'],
      page: 1,
      topk: 8,
    });
    expect(out.items).toHaveLength(2);
  });

  it('searchVector wysyła {label, propertyKey, queryVector, topk, efSearch=200}', async () => {
    const { client, calls } = makeClient(() => jsonResponse(fixture('search-data.json')));
    await searchVector(client, {
      projectId: 7,
      label: 'LightingDocs.Chunk',
      propertyKey: 'contentPreview',
      queryVector: [0.1, 0.2],
      topk: 5,
    });
    expect(calls[1]!.path).toBe('/public/v1/search/vector');
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({
      projectId: 7,
      label: 'LightingDocs.Chunk',
      propertyKey: 'contentPreview',
      queryVector: [0.1, 0.2],
      topk: 5,
      efSearch: 200,
    });
  });
});

describe('probeSearch', () => {
  it('raportuje textOk/vectorOk i wykryty kształt; błąd wektora nie wywraca sondy', async () => {
    const { client } = makeClient((path) => {
      if (path === '/public/v1/search/text') return jsonResponse(fixture('search-text-success-result.json'));
      return jsonResponse({ message: 'dimension mismatch' }, { status: 500 });
    });
    const probe = await probeSearch(client, 'LightingDocs');
    expect(probe).toEqual({ textOk: true, vectorOk: false, detectedShape: 'success_result' });
  });

  it('nieznane kształty obu odpowiedzi → oba false, shape unknown', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = makeClient(() => jsonResponse({ nonsense: true }));
    const probe = await probeSearch(client, 'LightingDocs');
    expect(probe).toEqual({ textOk: false, vectorOk: false, detectedShape: 'unknown' });
  });
});

describe('rrfFuse', () => {
  const text = { source: 'openspg_text', items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
  const vector = { source: 'openspg_vector', items: [{ id: 'b' }, { id: 'a' }] };

  it('scala z dedup po id, sumuje 1/(k+rank), zbiera sources', () => {
    const fused = rrfFuse([text, vector], { k: 60 });
    expect(fused.map((f) => f.id)).toEqual(['a', 'b', 'c']);
    const a = fused[0]!;
    expect(a.score).toBeCloseTo(1 / 61 + 1 / 62, 12);
    expect(a.sources).toEqual(['openspg_text', 'openspg_vector']);
    expect(fused[2]!.sources).toEqual(['openspg_text']);
  });

  it('jest deterministyczny: remisy rozstrzygane po id, kolejność list bez znaczenia dla zbioru', () => {
    const run1 = rrfFuse([text, vector]);
    const run2 = rrfFuse([text, vector]);
    expect(run1).toEqual(run2);
    // symetryczne listy → identyczne score → porządek po id
    const tie = rrfFuse([
      { source: 's1', items: [{ id: 'z' }, { id: 'm' }] },
      { source: 's2', items: [{ id: 'm' }, { id: 'z' }] },
    ]);
    expect(tie.map((f) => f.id)).toEqual(['m', 'z']);
  });

  it('duplikaty w obrębie jednej listy liczone raz (pierwsze wystąpienie)', () => {
    const fused = rrfFuse([{ source: 's', items: [{ id: 'a' }, { id: 'a' }, { id: 'b' }] }], { k: 1 });
    expect(fused[0]).toEqual({ id: 'a', score: 1 / 2, sources: ['s'] });
    expect(fused[1]).toEqual({ id: 'b', score: 1 / 4, sources: ['s'] });
  });
});
