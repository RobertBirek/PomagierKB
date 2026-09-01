import { describe, expect, it } from 'vitest';
import { kbSearchTool } from '../src/tools/index.js';
import { makeCtx, seedKb, seedLightingChunks, testDb } from './helpers-tools.js';

interface SearchOut {
  results: {
    id: string;
    namespace: string;
    title?: string;
    snippet: string;
    score: number;
    source: string;
    kbName?: string;
    label?: string;
    sourceRef?: string;
  }[];
  tookMs: number;
  degraded: boolean;
}

describe('kb_search', () => {
  it('znajduje po polsku z odmianą (trigram) i ma degraded:true bez openspg', async () => {
    const db = testDb();
    seedKb(db, 'LightingDocs');
    seedLightingChunks(db);
    const ctx = makeCtx(db); // openspg: null, llm: null → kanały OpenSPG pominięte

    // zapytanie w dopełniaczu, dokument ma miejscownik ('szynoprzewodach')
    const res = await kbSearchTool.handler(ctx, { query: 'maksymalne obciążenie szynoprzewodów' });
    expect(res.isError).toBeUndefined();
    const out = res.structured as SearchOut;
    expect(out.degraded).toBe(true);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.id).toBe('LightingDocs:Chunk:1');
    expect(out.results[0]?.namespace).toBe('LightingDocs');
    expect(out.results[0]?.source).toBe('fallback_fts');
    expect(out.results[0]?.score).toBeGreaterThan(0);
    expect(out.results[0]?.kbName).toBe('Baza LightingDocs');
    expect(out.results[0]?.label).toBe('LightingDocs.Chunk');
    expect(out.results[0]?.sourceRef).toBe('https://example.com/karta.pdf');
    expect(typeof out.tookMs).toBe('number');
    expect(res.text).toContain('Montaż szynoprzewodów');
    expect(res.text).toContain('tryb awaryjny');
  });

  it('namespace spoza profilu → błąd namespace_not_allowed', async () => {
    const db = testDb();
    seedKb(db, 'LightingDocs');
    seedKb(db, 'OtherDocs');
    seedLightingChunks(db);
    const ctx = makeCtx(db, { namespaces: ['LightingDocs'] });

    const res = await kbSearchTool.handler(ctx, { query: 'cokolwiek', namespaces: ['OtherDocs'] });
    expect(res.isError).toBe(true);
    expect((res.structured as { errorCode: string }).errorCode).toBe('namespace_not_allowed');
  });

  it('nieprawidłowe wejście → błąd validation (za krótkie query)', async () => {
    const db = testDb();
    seedKb(db, 'LightingDocs');
    const ctx = makeCtx(db);

    const res = await kbSearchTool.handler(ctx, { query: 'a' });
    expect(res.isError).toBe(true);
    expect((res.structured as { errorCode: string }).errorCode).toBe('validation');
  });

  it('brak trafień → pusta lista bez błędu', async () => {
    const db = testDb();
    seedKb(db, 'LightingDocs');
    seedLightingChunks(db);
    const ctx = makeCtx(db);

    const res = await kbSearchTool.handler(ctx, { query: 'kosmiczna winda orbitalna' });
    expect(res.isError).toBeUndefined();
    expect((res.structured as SearchOut).results).toHaveLength(0);
  });
});
