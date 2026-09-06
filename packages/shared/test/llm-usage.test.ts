import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { openDb, runMigrations, type Db } from '../src/db/index.js';
import { aggregateLlmUsage, recordLlmUsage, recordUsageFromResult, withBreaker } from '../src/llm/index.js';

/**
 * Rejestr kosztu LLM (ustalenie GAP-05): tokeny szły wyłącznie do rotowanego
 * logu pino — nie było ani trwałego zapisu, ani agregatu per model/baza.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
});
afterEach(() => db.close());

const DAY = 86_400_000;
const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

describe('recordLlmUsage / aggregateLlmUsage', () => {
  it('sumuje tokeny globalnie i w rozbiciu na model, cel i bazę', () => {
    recordLlmUsage(db, {
      endpoint: 'chat',
      purpose: 'llm.chat',
      model: 'gpt-a',
      namespace: 'Docs',
      promptTokens: 100,
      completionTokens: 20,
    });
    recordLlmUsage(db, { endpoint: 'chat', purpose: 'llm.chat', model: 'gpt-a', promptTokens: 50, completionTokens: 10 });
    recordLlmUsage(db, { endpoint: 'embeddings', purpose: 'llm.embeddings', model: 'emb-b', promptTokens: 400 });

    const agg = aggregateLlmUsage(db, iso(7 * DAY));
    expect(agg.calls).toBe(3);
    expect(agg.promptTokens).toBe(550);
    expect(agg.completionTokens).toBe(30);
    expect(agg.totalTokens).toBe(580);
    expect(agg.byModel.map((b) => [b.key, b.totalTokens])).toEqual([
      ['emb-b', 400],
      ['gpt-a', 180],
    ]);
    expect(agg.byPurpose.map((b) => b.key).sort()).toEqual(['llm.chat', 'llm.embeddings']);
    expect(agg.byNamespace.find((b) => b.key === 'Docs')?.totalTokens).toBe(120);
  });

  it('pomija wiersze spoza okna', () => {
    recordLlmUsage(db, { endpoint: 'chat', purpose: 'llm.chat', model: 'm', promptTokens: 1, at: iso(30 * DAY) });
    recordLlmUsage(db, { endpoint: 'chat', purpose: 'llm.chat', model: 'm', promptTokens: 2 });
    expect(aggregateLlmUsage(db, iso(7 * DAY)).promptTokens).toBe(2);
  });

  it('braki i wartości ujemne normalizuje do zera; zapis nigdy nie rzuca', () => {
    recordLlmUsage(db, { endpoint: 'chat', purpose: 'p', model: 'm', promptTokens: null, completionTokens: -5 });
    const agg = aggregateLlmUsage(db, iso(DAY));
    expect(agg.calls).toBe(1);
    expect(agg.totalTokens).toBe(0);
  });
});

describe('recordUsageFromResult', () => {
  it('zapisuje model i tokeny z wyniku chatu', () => {
    recordUsageFromResult(db, 'llm.chat', {
      text: 'x',
      model: 'gpt-a',
      usage: { promptTokens: 7, completionTokens: 3 },
    });
    const agg = aggregateLlmUsage(db, iso(DAY));
    expect(agg.totalTokens).toBe(10);
    expect(agg.byModel[0]?.key).toBe('gpt-a');
  });

  it('nie dubluje, gdy zużycie zgłosił już callback klienta (usageReported)', () => {
    recordUsageFromResult(db, 'llm.chat', {
      model: 'gpt-a',
      usage: { promptTokens: 7, completionTokens: 3 },
      usageReported: true,
    });
    expect(aggregateLlmUsage(db, iso(DAY)).calls).toBe(0);
  });

  it('wynik bez usage jest ignorowany (np. sondy OpenSPG)', () => {
    recordUsageFromResult(db, 'llm.chat', { hits: [1, 2, 3] });
    recordUsageFromResult(db, 'llm.chat', null);
    expect(aggregateLlmUsage(db, iso(DAY)).calls).toBe(0);
  });
});

describe('withBreaker jako punkt zapisu kosztu', () => {
  it('udane wywołanie llm.* trafia do rejestru', async () => {
    await withBreaker(db, 'llm.chat', async () => ({
      text: 'odpowiedź',
      model: 'gpt-a',
      usage: { promptTokens: 12, completionTokens: 8 },
    }));
    const agg = aggregateLlmUsage(db, iso(DAY));
    expect(agg.calls).toBe(1);
    expect(agg.totalTokens).toBe(20);
    expect(agg.byPurpose[0]?.key).toBe('llm.chat');
  });

  it('breaker o innej nazwie (openspg) nie zapisuje kosztu', async () => {
    await withBreaker(db, 'openspg', async () => ({ usage: { promptTokens: 1, completionTokens: 1 } }));
    expect(aggregateLlmUsage(db, iso(DAY)).calls).toBe(0);
  });
});
