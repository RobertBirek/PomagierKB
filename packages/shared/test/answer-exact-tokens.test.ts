import { describe, expect, it } from 'vitest';
import { applyExactTokenBoost, extractExactTokens, hybridSearch } from '../src/answer/index.js';
import type { AnswerCtx } from '../src/answer/index.js';
import { createKb, replaceForDocument, setProvisioned, type Db } from '../src/db/index.js';
import { OpenSpgClient } from '../src/openspg/client.js';
import { jsonResponse, loginResponse, makeMockFetch } from './helpers/openspg-mock.js';
import { testDb } from './helpers.js';

/**
 * Wzmocnienie dokładnych tokenów (2026-09-10, SubiektKB 42 tys. chunków): pytania o konkretną wersję
 * („nowości w 1.84 SP1") trafiały w sąsiednie numery (1.48 SP1, 1.06 SP1), bo embeddingi nie rozróżniają
 * numerów, a RRF nagradza zgodność kanałów, nie obecność tokenu. Kandydaci zawierający WSZYSTKIE dokładne
 * tokeny z pytania (wersje, identyfikatory z podkreśleniem) idą przed resztę; przy takich pytaniach FTS
 * pobiera szerszą pulę, żeby właściwy chunk w ogóle był wśród kandydatów.
 */

describe('extractExactTokens', () => {
  it('wyciąga numery wersji z sufiksami SP/HF i identyfikatory z podkreśleniem, bez duplikatów', () => {
    expect(extractExactTokens('Jakie nowości wprowadzono w Subiekcie GT w wersji 1.84 SP1?')).toEqual(['1.84 SP1']);
    expect(extractExactTokens('zmiany 1.22 SP3 HF1 i 1.89')).toEqual(['1.22 SP3 HF1', '1.89']);
    expect(extractExactTokens('jakie kolumny ma tabela tw__Towar i kolumna dok_Typ')).toEqual(['tw__Towar', 'dok_Typ']);
    expect(extractExactTokens('plik JPK_V7M z Rachmistrza, tabela tw__Towar, tw__Towar')).toEqual(['JPK_V7M', 'tw__Towar']);
  });
  it('ignoruje zwykłe liczby, daty, kwoty i słowa bez podkreślenia', () => {
    expect(extractExactTokens('faktura na 1500 zł z 2026-09-10 dla 3 stanowisk')).toEqual([]);
    expect(extractExactTokens('jak wystawić fakturę zaliczkową')).toEqual([]);
    expect(extractExactTokens('_ i __ i a_')).toEqual([]);
  });
});

describe('applyExactTokenBoost', () => {
  const ranked = [
    { id: 'A', score: 0.05, sources: ['openspg_vector'] },
    { id: 'B', score: 0.04, sources: ['fallback_fts'] },
    { id: 'C', score: 0.03, sources: ['fallback_fts'] },
  ];
  const text = new Map([
    ['A', 'Zmiany w InsERT GT 1.48 SP1 — lista zmian'],
    ['B', 'Zmiany w InsERT GT 1.84 SP1 HF1'],
    ['C', 'Zmiany w wersji 1.84 SP1: dodano obsługę kodów EAN'],
  ]);
  it('kandydaci z kompletem tokenów dostają bonus i źródło exact_match; remis zachowuje kolejność', () => {
    const out = applyExactTokenBoost(ranked, ['1.84 SP1'], (id) => text.get(id) ?? '');
    expect(out.map((h) => h.id)).toEqual(['B', 'C', 'A']);
    expect(out[0]!.sources).toContain('exact_match');
    expect(out[2]!.sources).not.toContain('exact_match');
  });
  it('dopasowanie bez rozróżniania wielkości liter i elastyczne spacje w wersji', () => {
    const out = applyExactTokenBoost(ranked, ['1.84SP1'], (id) => text.get(id) ?? '');
    expect(out[0]!.id).toBe('B');
    const out2 = applyExactTokenBoost(ranked, ['TW__TOWAR'], (id) => (id === 'C' ? 'kolumny tabeli tw__Towar' : ''));
    expect(out2[0]!.id).toBe('C');
  });
  it('bonus to dwa „pierwsze miejsca" RRF: przegrywa z konsensusem trzech kanałów, wygrywa z jednym', () => {
    // A = rank 1 w trzech kanałach (3/61 ≈ 0.049), C = rank 1 w jednym kanale (1/61) + bonus 2/61.
    const strong = [
      { id: 'A', score: 3 / 61, sources: ['fallback_fts', 'openspg_vector', 'openspg_text'] },
      { id: 'C', score: 1 / 61, sources: ['fallback_fts'] },
    ];
    expect(applyExactTokenBoost(strong, ['1.84 SP1'], (id) => text.get(id) ?? '').map((h) => h.id)).toEqual(['A', 'C']);
    const single = [
      { id: 'A', score: 1 / 61, sources: ['openspg_vector'] },
      { id: 'C', score: 1 / 70, sources: ['fallback_fts'] },
    ];
    expect(applyExactTokenBoost(single, ['1.84 SP1'], (id) => text.get(id) ?? '').map((h) => h.id)).toEqual(['C', 'A']);
  });
  it('bez tokenów albo bez żadnego dopasowania ranking pozostaje nietknięty', () => {
    expect(applyExactTokenBoost(ranked, [], () => 'x').map((h) => h.id)).toEqual(['A', 'B', 'C']);
    expect(applyExactTokenBoost(ranked, ['9.99'], (id) => text.get(id) ?? '').map((h) => h.id)).toEqual(['A', 'B', 'C']);
  });
});

const NS = 'SubiektTest';
function seed(db: Db): void {
  createKb(db, { namespace: NS, name: 'Subiekt test', embeddingModel: 'text-embedding-3-small' });
  db.prepare("UPDATE kb_registry SET status = 'active' WHERE namespace = ?").run(NS);
  setProvisioned(db, NS, 1, 'inst@text-embedding-3-small', 'h');
  const versions = ['1.06 SP1', '1.48 SP1', '1.67', '1.84 SP1', '1.84 SP1 HF1', '1.89'];
  versions.forEach((v, i) => {
    replaceForDocument(db, NS, `DOC_V${i}`, [
      {
        id: `CHUNK_V${i}_000`,
        title: `Zmiany w InsERT GT ${v}`,
        content: `Lista zmian w wersji ${v} systemu InsERT GT. Subiekt GT | Dodano nowości w wersji ${v}: obsługa kodów EAN i nowe wydruki.`,
      },
    ]);
  });
}
function ctxOf(db: Db, openspg: OpenSpgClient | null): AnswerCtx {
  return { db, llm: null, openspg, log: { warn: () => undefined } };
}
/** Kanał tekstowy OpenSPG „mylący numery": zwraca sąsiednie wersje wysoko, właściwą nisko. */
function confusedOpenspg(): OpenSpgClient {
  const { impl } = makeMockFetch((path) => {
    if (path === '/v1/accounts/login') return loginResponse();
    if (path === '/public/v1/search/text') {
      return jsonResponse([
        { docId: 'CHUNK_V1_000', score: 3.1, fields: {} },
        { docId: 'CHUNK_V0_000', score: 3.0, fields: {} },
        { docId: 'CHUNK_V2_000', score: 2.9, fields: {} },
        { docId: 'CHUNK_V3_000', score: 1.1, fields: {} },
      ]);
    }
    return jsonResponse([]);
  });
  return new OpenSpgClient({ baseUrl: 'http://openspg:8887', account: 'o', password: 'x', fetchImpl: impl });
}

describe('hybridSearch — wzmocnienie dokładnych tokenów', () => {
  it('pytanie o wersję 1.84 SP1 zwraca chunki tej wersji na czele, nie 1.48 SP1', async () => {
    const db = testDb();
    seed(db);
    const res = await hybridSearch(ctxOf(db, confusedOpenspg()), {
      query: 'Jakie nowości wprowadzono w Subiekcie GT w wersji 1.84 SP1?',
      allowedNamespaces: [NS],
      namespaces: [NS],
      limit: 3,
      mode: 'text',
    });
    const ids = res.results.map((r) => r.id);
    expect(ids.slice(0, 2).sort()).toEqual(['CHUNK_V3_000', 'CHUNK_V4_000']);
    expect(res.results[0]!.source).toBe('exact_match');
  });
  it('pytanie bez dokładnych tokenów nie zmienia rankingu kanałów', async () => {
    const db = testDb();
    seed(db);
    const res = await hybridSearch(ctxOf(db, confusedOpenspg()), {
      query: 'jakie nowości w Subiekcie GT',
      allowedNamespaces: [NS],
      namespaces: [NS],
      limit: 3,
      mode: 'text',
    });
    expect(res.results.every((r) => r.source !== 'exact_match')).toBe(true);
  });
});
