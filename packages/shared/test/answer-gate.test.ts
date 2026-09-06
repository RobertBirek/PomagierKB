import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANSWER_MIN_RELEVANCE_DEFAULT,
  answerQuestion,
  bestSemanticScore,
  clearAnswerCache,
  evaluateRelevanceGate,
  hybridSearch,
  NO_ANSWER_TEXT,
  resolveMinRelevance,
} from '../src/answer/index.js';
import type { AnswerCtx, AnswerLlm } from '../src/answer/index.js';
import { createKb, replaceForDocument, setProvisioned, type Db } from '../src/db/index.js';
import { OpenSpgClient } from '../src/openspg/client.js';
import { jsonResponse, loginResponse, makeMockFetch } from './helpers/openspg-mock.js';
import { testDb } from './helpers.js';

/**
 * D8-01 — bramka odmowy. Stara bramka (topNorm ≥ 0.2) była MATEMATYCZNIE martwa:
 * top fuzji RRF jest rank-1 w ≥1 kanale ⇒ topScore ≥ 1/61 ⇒ topNorm ≥ 1/kanały ≥ 1/3.
 * Ten plik jest dowodem, że nowa bramka rozróżnia trafienie od szumu: liczby
 * cosinusów pochodzą z żywego pomiaru (evidence/D8-vector-raw-scores.json).
 */

const NS = 'StagingSmoke';
const ON_TOPIC_SCORES = [0.871, 0.789, 0.778]; // pytania Z bazy
const OFF_TOPIC_SCORES = [0.635, 0.609, 0.515]; // pytania SPOZA bazy

describe('evaluateRelevanceGate (czysta logika)', () => {
  const base = { lexicalStrict: true, minRelevance: ANSWER_MIN_RELEVANCE_DEFAULT };

  it('stary wzór topNorm był martwy — dowód arytmetyczny', () => {
    const RRF_TOP1 = 1 / 61;
    for (const channels of [1, 2, 3]) {
      const topScore = RRF_TOP1; // minimum możliwe dla NIEPUSTEGO wyniku fuzji
      expect(topScore / (channels * RRF_TOP1)).toBeGreaterThan(0.2); // stary próg
    }
  });

  it('pusty wynik → odmowa niezależnie od sygnałów', () => {
    expect(evaluateRelevanceGate({ ...base, resultCount: 0, semanticScore: 0.99 })).toMatchObject({
      pass: false,
      reason: 'no_results',
    });
  });

  it('cosinus on-topic przechodzi, off-topic jest odrzucany (żywy rozkład)', () => {
    for (const s of ON_TOPIC_SCORES) {
      expect(
        evaluateRelevanceGate({ ...base, resultCount: 3, semanticScore: s }).pass,
        `on-topic ${s} powinien przejść`,
      ).toBe(true);
    }
    for (const s of OFF_TOPIC_SCORES) {
      expect(
        evaluateRelevanceGate({ ...base, resultCount: 3, semanticScore: s }),
        `off-topic ${s} powinien być odrzucony`,
      ).toMatchObject({ pass: false, reason: 'low_relevance' });
    }
  });

  it('próg 0.7 leży między rozkładami z zapasem po obu stronach', () => {
    expect(Math.min(...ON_TOPIC_SCORES)).toBeGreaterThan(ANSWER_MIN_RELEVANCE_DEFAULT);
    expect(Math.max(...OFF_TOPIC_SCORES)).toBeLessThan(ANSWER_MIN_RELEVANCE_DEFAULT);
  });

  it('bez sygnału semantycznego liczy się AND leksykalny; luźny OR to za mało', () => {
    expect(
      evaluateRelevanceGate({ ...base, resultCount: 2, semanticScore: null, lexicalStrict: true }).pass,
    ).toBe(true);
    expect(
      evaluateRelevanceGate({ ...base, resultCount: 2, semanticScore: null, lexicalStrict: false }),
    ).toMatchObject({ pass: false, reason: 'lexical_fallback_only' });
  });

  it('resolveMinRelevance: wartości legacy (<0.5) → default; sensowne honorowane', () => {
    expect(resolveMinRelevance(0.01)).toBe(ANSWER_MIN_RELEVANCE_DEFAULT); // surowy RRF
    expect(resolveMinRelevance(0.2)).toBe(ANSWER_MIN_RELEVANCE_DEFAULT); // martwa normalizacja
    expect(resolveMinRelevance(null)).toBe(ANSWER_MIN_RELEVANCE_DEFAULT);
    expect(resolveMinRelevance(Number.NaN)).toBe(ANSWER_MIN_RELEVANCE_DEFAULT);
    expect(resolveMinRelevance(0.8)).toBe(0.8);
    expect(resolveMinRelevance(5)).toBe(0.99); // clamp
  });

  it('bestSemanticScore bierze najlepszy dostępny sygnał', () => {
    expect(bestSemanticScore(0.6, 0.82)).toBe(0.82);
    expect(bestSemanticScore(null, 0.5)).toBe(0.5);
    expect(bestSemanticScore(null, undefined)).toBeNull();
  });
});

// ── Integracja: bramka na ścieżce answerQuestion, z kanałem wektorowym ────────

/** Realna treść bazy StagingSmoke (audyt D8). */
function seedCorpus(db: Db): void {
  createKb(db, { namespace: NS, name: 'Staging', embeddingModel: 'text-embedding-3-small' });
  db.prepare("UPDATE kb_registry SET status = 'active' WHERE namespace = ?").run(NS);
  setProvisioned(db, NS, 7, 'inst1@text-embedding-3-small', 'hash');
  replaceForDocument(db, NS, 'DOC_EF8A5D4D', [
    {
      id: 'CHUNK_EF8A5D4D_000',
      title: 'Oprawa HighBay LED 150W — karta produktu',
      content:
        'Oprawa przemysłowa HighBay LED 150W przeznaczona do magazynów wysokiego składowania. ' +
        'Strumień świetlny: 21000 lm, skuteczność 140 lm/W. Stopień ochrony IP65, odporność IK08.',
    },
    {
      id: 'CHUNK_EF8A5D4D_001',
      title: 'Oprawa HighBay LED 150W — karta produktu',
      content:
        'Wersja DALI-2 pozwala na ściemnianie i integrację z systemem zarządzania budynkiem. ' +
        'Czujnik ruchu (opcja) ogranicza zużycie energii do 40% w strefach o małym ruchu.',
    },
  ]);
}

/** Klient OpenSPG zwracający wektorowe trafienia o zadanych score'ach. */
function fakeOpenspg(vectorScores: number[]): OpenSpgClient {
  const ids = ['CHUNK_EF8A5D4D_000', 'CHUNK_EF8A5D4D_001'];
  const { impl } = makeMockFetch((path) => {
    if (path === '/v1/accounts/login') return loginResponse();
    if (path === '/public/v1/search/vector') {
      return jsonResponse(
        vectorScores.map((score, i) => ({ docId: ids[i % ids.length], score, fields: {} })),
      );
    }
    return jsonResponse([]); // search/text: bez trafień (izolujemy sygnał wektorowy)
  });
  return new OpenSpgClient({
    baseUrl: 'http://openspg:8887',
    account: 'openspg',
    password: 'x',
    fetchImpl: impl,
  });
}

interface Counter {
  llm: AnswerLlm;
  chat: number;
  embed: number;
}

/**
 * LLM stub: embed zwraca wektory o zadanym cosinusie do zapytania, chat liczy
 * wywołania (bramka ma je trzymać na zerze dla pytań spoza bazy).
 */
function stubLlm(rerankCosine: number): Counter {
  const c: Counter = {
    chat: 0,
    embed: 0,
    llm: {
      async chat() {
        c.chat += 1;
        return { text: 'Odpowiedź ze źródła [1].\nCONFIDENCE: 0.9' };
      },
      async embed(texts: string[]) {
        c.embed += 1;
        // [1,0] dla zapytania; [cos, sin] dla treści → cosinus = rerankCosine
        const sin = Math.sqrt(Math.max(0, 1 - rerankCosine * rerankCosine));
        return texts.map((_t, i) => (i === 0 ? [1, 0] : [rerankCosine, sin]));
      },
    },
  };
  return c;
}

function makeCtx(db: Db, llm: AnswerLlm | null, openspg: OpenSpgClient | null): AnswerCtx {
  return { db, llm, openspg, log: { warn: () => undefined } };
}

describe('bramka odmowy w answerQuestion (integracja)', () => {
  beforeEach(() => clearAnswerCache());
  afterEach(() => vi.restoreAllMocks());

  it('trafienie na temat (cosinus 0.871) → odpowiedź, chat wywołany', async () => {
    const db = testDb();
    seedCorpus(db);
    const llm = stubLlm(0.9);
    const res = await answerQuestion(makeCtx(db, llm.llm, fakeOpenspg([0.871, 0.691])), {
      question: 'Jaki jest strumień świetlny oprawy HighBay LED 150W?',
      allowedNamespaces: [NS],
      source: 'mcp',
    });
    expect(res.noAnswer).toBe(false);
    expect(llm.chat).toBe(1);
    expect(res.citations.length).toBeGreaterThan(0);
  });

  it('pytanie SPOZA bazy z niepustym wynikiem (cosinus 0.609) → odmowa, ZERO chatu', async () => {
    const db = testDb();
    seedCorpus(db);
    const llm = stubLlm(0.4);
    const res = await answerQuestion(makeCtx(db, llm.llm, fakeOpenspg([0.609, 0.598])), {
      question: 'przepis na bigos staropolski',
      allowedNamespaces: [NS],
      source: 'mcp',
    });
    expect(res.noAnswer).toBe(true);
    expect(res.answer).toBe(NO_ANSWER_TEXT);
    expect(llm.chat).toBe(0); // KLUCZOWE: chat nie został wywołany
    expect(res.gapRecorded).toBe(true);
    const gap = db.prepare('SELECT metadata_json FROM learning_gaps').get() as {
      metadata_json: string;
    };
    expect(gap.metadata_json).toContain('low_relevance');
  });

  it('cały zestaw negatywów z benchmarku audytu jest odrzucany', async () => {
    const negatives: [string, number][] = [
      ['przepis na bigos staropolski', 0.609],
      ['kurs dolara do złotego', 0.635],
      ['python list comprehension example', 0.515],
    ];
    for (const [question, score] of negatives) {
      clearAnswerCache();
      const db = testDb();
      seedCorpus(db);
      const llm = stubLlm(0.4);
      const res = await answerQuestion(makeCtx(db, llm.llm, fakeOpenspg([score, score - 0.01])), {
        question,
        allowedNamespaces: [NS],
        source: 'mcp',
      });
      expect(res.noAnswer, `negatyw '${question}' przeszedł bramkę`).toBe(true);
      expect(llm.chat, `negatyw '${question}' spalił chat`).toBe(0);
    }
  });

  it('tryb zdegradowany (sam FTS): AND przechodzi, luźny OR jest odrzucany', async () => {
    const db = testDb();
    seedCorpus(db);
    // AND: wszystkie rdzenie w chunku
    const strict = await hybridSearch(makeCtx(db, null, null), {
      query: 'strumień świetlny oprawy HighBay',
      allowedNamespaces: [NS],
    });
    expect(strict.lexicalStrict).toBe(true);
    expect(strict.topVectorScore).toBeNull();

    // adwersarialny negatyw: trafia tylko luźnym OR (podciąg rdzenia)
    const loose = await hybridSearch(makeCtx(db, null, null), {
      query: 'procedura zgłaszania urlopu w systemie kadrowym',
      allowedNamespaces: [NS],
    });
    expect(loose.lexicalStrict).toBe(false);

    const llm = stubLlm(0.4);
    const res = await answerQuestion(makeCtx(db, llm.llm, null), {
      question: 'procedura zgłaszania urlopu w systemie kadrowym',
      allowedNamespaces: [NS],
      source: 'mcp',
    });
    expect(res.noAnswer).toBe(true);
    expect(llm.chat).toBe(0);
  });

  it('trafienie cache dostaje własny wiersz answers z atrybucją wołającego (D8-11)', async () => {
    const db = testDb();
    seedCorpus(db);
    const question = 'Jaki jest strumień świetlny oprawy HighBay LED 150W?';
    const llm = stubLlm(0.9);
    const first = await answerQuestion(makeCtx(db, llm.llm, fakeOpenspg([0.871, 0.691])), {
      question,
      allowedNamespaces: [NS],
      source: 'panel',
      userId: 'u-viewer',
    });
    expect(first.noAnswer).toBe(false);
    const second = await answerQuestion(makeCtx(db, llm.llm, fakeOpenspg([0.871, 0.691])), {
      question,
      allowedNamespaces: [NS],
      source: 'mcp',
      apiKeyId: 'key1',
    });
    expect(llm.chat, 'drugie wywołanie miało pójść z cache').toBe(1);
    expect(second.answerId).not.toBe(first.answerId); // feedback nie trafia w cudzy wiersz
    const rows = db.prepare('SELECT id, source, api_key_id, user_id FROM answers ORDER BY id').all() as {
      id: string;
      source: string;
      api_key_id: string | null;
      user_id: string | null;
    }[];
    expect(rows).toHaveLength(2); // wolumen liczy też trafienia cache
    expect(rows.find((r) => r.id === second.answerId)).toMatchObject({ source: 'mcp', api_key_id: 'key1' });
  });

  it('kb_dirty (mirror wyprzedza graf) blokuje zapis do cache (D8-11)', async () => {
    const db = testDb();
    seedCorpus(db);
    db.prepare("UPDATE kb_registry SET dirty = 1 WHERE namespace = ?").run(NS);
    const question = 'Jaki jest strumień świetlny oprawy HighBay LED 150W?';
    const llm = stubLlm(0.9);
    for (let i = 0; i < 2; i++) {
      await answerQuestion(makeCtx(db, llm.llm, fakeOpenspg([0.871, 0.691])), {
        question,
        allowedNamespaces: [NS],
        source: 'mcp',
      });
    }
    expect(llm.chat, 'odpowiedź z okna kb_dirty nie może żyć w cache').toBe(2);
  });

  it('kanał wektorowy niesie surowy cosinus do RetrievalHit i topVectorScore', async () => {
    const db = testDb();
    seedCorpus(db);
    const llm = stubLlm(0.9);
    const res = await hybridSearch(makeCtx(db, llm.llm, fakeOpenspg([0.871, 0.691])), {
      query: 'strumień świetlny',
      allowedNamespaces: [NS],
    });
    expect(res.topVectorScore).toBeCloseTo(0.871, 5);
    expect(res.results.some((r) => r.vectorScore === 0.871)).toBe(true);
  });
});
