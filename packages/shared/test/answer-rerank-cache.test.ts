import { describe, expect, it } from 'vitest';
import {
  answerCacheKey,
  chatConfigFingerprint,
  clearAnswerCache,
  cosine,
  dataVersion,
  getCachedAnswer,
  parseLlmOrder,
  parseRewriteResponse,
  putCachedAnswer,
  rerankHits,
} from '../src/answer/index.js';
import type { AnswerResult, RetrievalHit } from '../src/answer/index.js';
import { createKb, finishExportRun, replaceForDocument, startExportRun } from '../src/db/index.js';
import { testDb } from './helpers.js';

/** Faza 9: rewrite/rerank/cache — czysta logika. */

describe('parseRewriteResponse', () => {
  it('poprawny JSON → fraza + keywords; śmieci → fallback na oryginał', () => {
    expect(parseRewriteResponse('{"rewritten":"obciążenie szynoprzewód","keywords":["16A"]}', 'q')).toEqual({
      rewritten: 'obciążenie szynoprzewód',
      keywords: ['16A'],
    });
    expect(parseRewriteResponse('nie-json', 'oryginał')).toEqual({ rewritten: 'oryginał', keywords: [] });
    expect(parseRewriteResponse('{"rewritten":""}', 'oryginał').rewritten).toBe('oryginał');
  });
});

describe('cosine + rerank embed', () => {
  it('cosine: identyczne=1, ortogonalne=0, zerowy wektor=0', () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });

  it("strategia 'embed' porządkuje po cosinusie do zapytania i zwraca topCosine", async () => {
    const db = testDb();
    createKb(db, { namespace: 'KbX', name: 'X' });
    replaceForDocument(db, 'KbX', 'DOC_x', [
      { id: 'CHUNK_x_001', content: 'treść daleka' },
      { id: 'CHUNK_x_002', content: 'treść bliska' },
    ]);
    const hits: RetrievalHit[] = [
      { id: 'CHUNK_x_001', namespace: 'KbX', snippet: 'daleka', score: 0.03, source: 'fallback_fts' },
      { id: 'CHUNK_x_002', namespace: 'KbX', snippet: 'bliska', score: 0.02, source: 'fallback_fts' },
    ];
    // embed: zapytanie=[1,0]; daleka=[0,1] (cos 0); bliska=[0.9,0.1] (cos ~0.99)
    const llm = {
      chat: async () => ({ text: '' }),
      embed: async (texts: string[]) =>
        texts.map((t) => (t.includes('bliska') ? [0.9, 0.1] : t.includes('daleka') ? [0, 1] : [1, 0])),
    };
    const out = await rerankHits(db, llm, 'embed', 'zapytanie', hits);
    expect(out.hits[0]?.id).toBe('CHUNK_x_002');
    expect(out.topCosine).toBeGreaterThan(0.9);
    expect(out.strategy).toBe('embed');
  });

  it('błąd embed → oryginalna kolejność (rerank nigdy nie wywraca)', async () => {
    const db = testDb();
    const hits: RetrievalHit[] = [
      { id: 'A', namespace: 'X', snippet: 'a', score: 1, source: 'fallback_fts' },
      { id: 'B', namespace: 'X', snippet: 'b', score: 0.5, source: 'fallback_fts' },
    ];
    const llm = {
      chat: async () => ({ text: '' }),
      embed: async () => {
        throw new Error('embed down');
      },
    };
    const out = await rerankHits(db, llm, 'embed', 'q', hits);
    expect(out.hits.map((h) => h.id)).toEqual(['A', 'B']);
    expect(out.strategy).toBe('off');
  });

  it('parseLlmOrder wyciąga znane id w kolejności, ignoruje halucynacje', () => {
    const ids = ['CHUNK_a_001', 'CHUNK_b_002'];
    const order = parseLlmOrder('Najlepsze:\nCHUNK_b_002\nCHUNK_fake_009\nCHUNK_a_001\nCHUNK_b_002', ids);
    expect(order).toEqual(['CHUNK_b_002', 'CHUNK_a_001']);
  });
});

describe('cache odpowiedzi', () => {
  const answer: AnswerResult = {
    answer: 'Odp',
    citations: [],
    confidence: 0.9,
    model: 'm',
    degraded: false,
    gapRecorded: false,
    noAnswer: false,
    answerId: 'ans_x',
    warnings: [],
  };

  it('klucz zależy od pytania, ns, modelu i wersji danych; TTL wygasza', () => {
    clearAnswerCache();
    const k1 = answerCacheKey('Pytanie?', ['A', 'B'], 'm', 5);
    expect(answerCacheKey('pytanie?', ['B', 'A'], 'm', 5)).toBe(k1); // normalizacja + sort ns
    expect(answerCacheKey('Pytanie?', ['A', 'B'], 'm', 6)).not.toBe(k1); // rebuild unieważnia
    expect(answerCacheKey('Pytanie?', ['A'], 'm', 5)).not.toBe(k1);

    const t0 = 1_000_000;
    putCachedAnswer(k1, answer, t0);
    expect(getCachedAnswer(k1, t0 + 1000)?.answerId).toBe('ans_x');
    expect(getCachedAnswer(k1, t0 + 61 * 60 * 1000)).toBeNull(); // po TTL 1 h
  });

  it('klucz rozróżnia language/maxSources/próg/rerank/rewrite (D8-11)', () => {
    const opts = {
      language: 'pl' as const,
      maxSources: 6,
      minRelevance: 0.7,
      rerank: 'embed',
      rewrite: false,
    };
    const base = answerCacheKey('Pytanie?', ['A'], 'm', 5, opts);
    // to samo pytanie po angielsku NIE MOŻE oddać polskiej odpowiedzi z cache
    expect(answerCacheKey('Pytanie?', ['A'], 'm', 5, { ...opts, language: 'en' })).not.toBe(base);
    expect(answerCacheKey('Pytanie?', ['A'], 'm', 5, { ...opts, maxSources: 10 })).not.toBe(base);
    expect(answerCacheKey('Pytanie?', ['A'], 'm', 5, { ...opts, minRelevance: 0.85 })).not.toBe(base);
    expect(answerCacheKey('Pytanie?', ['A'], 'm', 5, { ...opts, rerank: 'off' })).not.toBe(base);
    expect(answerCacheKey('Pytanie?', ['A'], 'm', 5, { ...opts, rewrite: true })).not.toBe(base);
    expect(answerCacheKey('Pytanie?', ['A'], 'm', 5, { ...opts })).toBe(base); // deterministyczny
  });

  it('chatConfigFingerprint zmienia się przy edycji llm.chat i nie ujawnia sekretu', () => {
    const db = testDb();
    expect(chatConfigFingerprint(db)).toBe(''); // brak ustawienia
    db.prepare(
      `INSERT INTO settings (key, value_json, is_secret, updated_at) VALUES ('llm.chat', ?, 1, ?)`,
    ).run(JSON.stringify({ sealed: 'AAAA-tajne' }), '2026-01-01T00:00:00.000Z');
    const f1 = chatConfigFingerprint(db);
    expect(f1).toMatch(/^[0-9a-f]{16}$/);
    expect(f1).not.toContain('tajne');
    db.prepare(`UPDATE settings SET value_json = ?, updated_at = ? WHERE key = 'llm.chat'`).run(
      JSON.stringify({ sealed: 'BBBB-inne' }),
      '2026-01-02T00:00:00.000Z',
    );
    expect(chatConfigFingerprint(db)).not.toBe(f1);
  });

  it('dataVersion: max id udanego eksportu w ns; brak eksportów = 0', () => {
    const db = testDb();
    createKb(db, { namespace: 'KbC', name: 'C' });
    expect(dataVersion(db, ['KbC'])).toBe(0);
    const run1 = startExportRun(db, 'KbC');
    finishExportRun(db, run1.id, 'success', { docCount: 1, chunkCount: 1 });
    const v1 = dataVersion(db, ['KbC']);
    expect(v1).toBe(run1.id);
    const run2 = startExportRun(db, 'KbC');
    finishExportRun(db, run2.id, 'success', { docCount: 1, chunkCount: 2 });
    expect(dataVersion(db, ['KbC'])).toBeGreaterThan(v1);
  });
});
