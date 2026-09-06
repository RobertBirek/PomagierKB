import { describe, expect, it } from 'vitest';
import { buildOpenSpgTextQuery, hybridSearch } from '../src/answer/index.js';
import type { AnswerCtx, AnswerLlm } from '../src/answer/index.js';
import { createKb, replaceForDocument, setProvisioned, type Db } from '../src/db/index.js';
import { OpenSpgClient } from '../src/openspg/client.js';
import { jsonResponse, loginResponse, makeMockFetch } from './helpers/openspg-mock.js';
import { testDb } from './helpers.js';

/**
 * D8-03 (kanał tekstowy OpenSPG dopasowywał stopwordy → wszystkie węzły jako rank 1)
 * oraz D8-10 (embed zapytania siedział WEWNĄTRZ withBreaker('openspg'), więc awaria
 * dostawcy embeddingów otwierała breaker zdrowego OpenSPG i gasiła kanał tekstowy).
 */

const NS = 'StagingSmoke';

function seed(db: Db): void {
  createKb(db, { namespace: NS, name: 'Staging', embeddingModel: 'text-embedding-3-small' });
  db.prepare("UPDATE kb_registry SET status = 'active' WHERE namespace = ?").run(NS);
  setProvisioned(db, NS, 1, 'inst@text-embedding-3-small', 'h');
  replaceForDocument(db, NS, 'DOC_EF8A5D4D', [
    {
      id: 'CHUNK_EF8A5D4D_000',
      title: 'Oprawa HighBay LED 150W',
      content: 'Strumień świetlny: 21000 lm, skuteczność 140 lm/W. Stopień ochrony IP65.',
    },
    {
      id: 'CHUNK_EF8A5D4D_001',
      title: 'Sterowanie',
      content: 'Wersja DALI-2 pozwala na ściemnianie i integrację z systemem zarządzania budynkiem.',
    },
  ]);
}

function ctxOf(db: Db, llm: AnswerLlm | null, openspg: OpenSpgClient | null): AnswerCtx {
  return { db, llm, openspg, log: { warn: () => undefined } };
}

/** Klient OpenSPG: search/text zwraca trafienia o zadanych score'ach, vector nic. */
function textOnlyOpenspg(hits: { id: string; score: number }[], seenQueries: string[]): OpenSpgClient {
  const { impl } = makeMockFetch((path, init) => {
    if (path === '/v1/accounts/login') return loginResponse();
    if (path === '/public/v1/search/text') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { queryString?: string };
      seenQueries.push(body.queryString ?? '');
      return jsonResponse(hits.map((h) => ({ docId: h.id, score: h.score, fields: {} })));
    }
    return jsonResponse([]);
  });
  return new OpenSpgClient({ baseUrl: 'http://openspg:8887', account: 'o', password: 'x', fetchImpl: impl });
}

describe('buildOpenSpgTextQuery (D8-03)', () => {
  it('wyrzuca stopwordy i tokeny <3 znaków, zachowuje formy oryginalne', () => {
    expect(buildOpenSpgTextQuery('Jaki jest strumień świetlny oprawy w hali?')).toBe(
      'strumień świetlny oprawy hali',
    );
    expect(buildOpenSpgTextQuery('czy oprawa ma DALI')).toBe('oprawa DALI');
    // samo „na/w/do" nie może iść do kanału (dopasowywało WSZYSTKIE węzły)
    expect(buildOpenSpgTextQuery('na w do')).toBeNull();
    expect(buildOpenSpgTextQuery('jak co gdzie kiedy')).toBeNull();
  });
});

describe('kanał openspg_text (D8-03)', () => {
  it('do OpenSPG idzie zapytanie oczyszczone ze stopwordów', async () => {
    const db = testDb();
    seed(db);
    const seen: string[] = [];
    const res = await hybridSearch(ctxOf(db, null, textOnlyOpenspg([{ id: 'CHUNK_EF8A5D4D_000', score: 1.2 }], seen)), {
      query: 'Jaki jest strumień świetlny oprawy?',
      allowedNamespaces: [NS],
    });
    expect(seen[0]).toBe('strumień świetlny oprawy');
    expect(res.results.length).toBeGreaterThan(0);
  });

  it('trafienia „stopwordowe" (score < 0.3) są odsiewane', async () => {
    const db = testDb();
    seed(db);
    const seen: string[] = [];
    const noisy = textOnlyOpenspg(
      [
        { id: 'CHUNK_EF8A5D4D_000', score: 0.15 },
        { id: 'CHUNK_EF8A5D4D_001', score: 0.28 },
      ],
      seen,
    );
    const res = await hybridSearch(ctxOf(db, null, noisy), {
      // zapytanie spoza korpusu: FTS nic nie znajdzie, więc jedyne trafienia mogłyby
      // przyjść z szumu kanału tekstowego
      query: 'harmonogram pociągów Warszawa Kraków',
      allowedNamespaces: [NS],
    });
    expect(res.results).toHaveLength(0);
  });

  it('trafienia merytoryczne (score ≥ 0.3) przechodzą', async () => {
    const db = testDb();
    seed(db);
    const seen: string[] = [];
    const res = await hybridSearch(ctxOf(db, null, textOnlyOpenspg([{ id: 'CHUNK_EF8A5D4D_001', score: 0.43 }], seen)), {
      query: 'harmonogram pociągów Warszawa Kraków',
      allowedNamespaces: [NS],
    });
    expect(res.results.map((r) => r.id)).toContain('CHUNK_EF8A5D4D_001');
  });
});

describe('breaker: embed zapytania poza withBreaker(openspg) (D8-10)', () => {
  it('awaria embeddingów NIE otwiera breakera openspg i nie gasi kanału tekstowego', async () => {
    const db = testDb();
    seed(db);
    const brokenEmbed: AnswerLlm = {
      async chat() {
        return { text: '' };
      },
      async embed() {
        throw new Error('429 Too Many Requests (OpenAI)');
      },
    };
    const seen: string[] = [];
    const openspg = textOnlyOpenspg([{ id: 'CHUNK_EF8A5D4D_000', score: 1.5 }], seen);

    // trzy kolejne wyszukiwania — pod starym kodem to wystarczało, by otworzyć breaker
    for (let i = 0; i < 3; i++) {
      const res = await hybridSearch(ctxOf(db, brokenEmbed, openspg), {
        query: 'strumień świetlny oprawy',
        allowedNamespaces: [NS],
      });
      expect(res.results.length, 'kanał tekstowy musi działać mimo awarii embeddingów').toBeGreaterThan(0);
      expect(res.degradedReasons).toContain('embed_failed');
      expect(res.degradedReasons).not.toContain('openspg_down');
      expect(res.topVectorScore).toBeNull();
    }

    const breaker = db.prepare("SELECT state, failure_count FROM breakers WHERE name = 'openspg'").get() as
      | { state: string; failure_count: number }
      | undefined;
    // breaker albo w ogóle nie zapisany, albo zamknięty z zerem porażek
    expect(breaker?.state ?? 'closed').toBe('closed');
    expect(breaker?.failure_count ?? 0).toBe(0);
  });
});
