import { describe, expect, it } from 'vitest';
import {
  ASK_THREAD_MAX_ENTRIES,
  deserializeThread,
  groupHistory,
  historyGroupId,
  nextThreadKey,
  serializeThread,
  type ThreadEntry,
  type ThreadResult,
} from '../src/lib/askThread';

function makeResult(overrides: Partial<ThreadResult> = {}): ThreadResult {
  return {
    answer: 'Odpowiedź testowa',
    citations: [{ n: 1, id: 'chunk-1', namespace: 'kb_test', title: 'Doc' }],
    confidence: 0.8,
    model: 'gpt-test',
    degraded: false,
    gapRecorded: false,
    noAnswer: false,
    answerId: 'ans-1',
    warnings: [],
    ...overrides,
  };
}

function makeEntry(overrides: Partial<ThreadEntry> = {}): ThreadEntry {
  return {
    key: 1,
    question: 'Jakie mamy produkty?',
    result: makeResult(),
    error: null,
    stopped: false,
    verdict: null,
    ...overrides,
  };
}

describe('serializeThread() / deserializeThread()', () => {
  it('roundtrip zachowuje pytania, wyniki, błędy, stopped i verdict', () => {
    const entries: ThreadEntry[] = [
      makeEntry({ key: 1, verdict: 'up' }),
      makeEntry({ key: 2, question: 'Drugie pytanie?', result: null, error: 'timeout' }),
      makeEntry({ key: 3, question: 'Trzecie?', result: null, stopped: true }),
    ];
    const restored = deserializeThread(serializeThread(entries));
    expect(restored).toHaveLength(3);
    expect(restored[0]?.question).toBe('Jakie mamy produkty?');
    expect(restored[0]?.verdict).toBe('up');
    expect(restored[0]?.result?.answerId).toBe('ans-1');
    expect(restored[0]?.result?.citations).toEqual([{ n: 1, id: 'chunk-1', namespace: 'kb_test', title: 'Doc' }]);
    expect(restored[1]?.error).toBe('timeout');
    expect(restored[1]?.result).toBeNull();
    expect(restored[2]?.stopped).toBe(true);
  });

  it('serializacja POMIJA pole phase (stan przejściowy SSE)', () => {
    const withPhase = [{ ...makeEntry(), phase: 'generating' }];
    const raw = serializeThread(withPhase as unknown as ThreadEntry[]);
    expect(raw).not.toContain('phase');
  });

  it('klucze wpisów są przenumerowywane rosnąco od 1', () => {
    const restored = deserializeThread(
      serializeThread([makeEntry({ key: 7 }), makeEntry({ key: 42, question: 'Q2?' })]),
    );
    expect(restored.map((e) => e.key)).toEqual([1, 2]);
  });

  it('zepsuty JSON / nie-obiekt / brak entries → []', () => {
    expect(deserializeThread('{nie-json')).toEqual([]);
    expect(deserializeThread('null')).toEqual([]);
    expect(deserializeThread('"tekst"')).toEqual([]);
    expect(deserializeThread('{"v":1}')).toEqual([]);
    expect(deserializeThread(null)).toEqual([]);
    expect(deserializeThread('')).toEqual([]);
  });

  it('wpisy bez pytania i śmieciowe elementy są pomijane', () => {
    const raw = JSON.stringify({
      v: 1,
      entries: [
        { question: 'OK?', result: null, error: null, stopped: false, verdict: null },
        { result: null }, // brak question
        'string',
        null,
        { question: '' }, // puste pytanie
      ],
    });
    const restored = deserializeThread(raw);
    expect(restored).toHaveLength(1);
    expect(restored[0]?.question).toBe('OK?');
  });

  it('zły verdict → null; zepsuty result → null; śmieciowe cytowania odfiltrowane', () => {
    const raw = JSON.stringify({
      v: 1,
      entries: [
        {
          question: 'Q?',
          verdict: 'maybe',
          result: {
            answer: 'A',
            answerId: 'ans-9',
            citations: [{ n: 1, id: 'c1', namespace: 'kb' }, { n: 'x' }, null, { id: 'bez-n' }],
          },
        },
        { question: 'Q2?', result: { answer: 42 } }, // answer nie-string → result null
      ],
    });
    const restored = deserializeThread(raw);
    expect(restored[0]?.verdict).toBeNull();
    expect(restored[0]?.result?.citations).toEqual([{ n: 1, id: 'c1', namespace: 'kb' }]);
    expect(restored[0]?.result?.confidence).toBe(0);
    expect(restored[1]?.result).toBeNull();
  });

  it('przycina wątek do ostatnich ASK_THREAD_MAX_ENTRIES wpisów', () => {
    const entries = Array.from({ length: ASK_THREAD_MAX_ENTRIES + 10 }, (_, i) =>
      makeEntry({ key: i + 1, question: `Pytanie ${i + 1}?`, result: null }),
    );
    const restored = deserializeThread(serializeThread(entries));
    expect(restored).toHaveLength(ASK_THREAD_MAX_ENTRIES);
    expect(restored[0]?.question).toBe('Pytanie 11?');
  });
});

describe('nextThreadKey()', () => {
  it('pusty wątek → 1; inaczej max+1', () => {
    expect(nextThreadKey([])).toBe(1);
    expect(nextThreadKey([{ key: 3 }, { key: 7 }, { key: 2 }])).toBe(8);
  });
});

describe('historyGroupId() / groupHistory()', () => {
  // Czwartek 3.09.2026, 12:00 lokalnie (poniedziałek tygodnia = 31.08).
  const now = new Date(2026, 8, 3, 12, 0, 0);
  const iso = (y: number, m: number, d: number, h = 10) => new Date(y, m, d, h).toISOString();

  it('dzisiaj / wczoraj / bieżący tydzień (od poniedziałku) / starsze', () => {
    expect(historyGroupId(iso(2026, 8, 3), now)).toBe('today');
    expect(historyGroupId(iso(2026, 8, 2), now)).toBe('yesterday');
    expect(historyGroupId(iso(2026, 8, 1), now)).toBe('week'); // wtorek
    expect(historyGroupId(iso(2026, 7, 31), now)).toBe('week'); // poniedziałek
    expect(historyGroupId(iso(2026, 7, 30), now)).toBe('older'); // niedziela poprzedniego tygodnia
    expect(historyGroupId(iso(2025, 0, 1), now)).toBe('older');
  });

  it('zepsuta data → older; przyszłość → today (defensywnie)', () => {
    expect(historyGroupId('nie-data', now)).toBe('older');
    expect(historyGroupId('', now)).toBe('older');
    expect(historyGroupId(iso(2026, 8, 4), now)).toBe('today');
  });

  it('groupHistory: stała kolejność sekcji, puste pomijane, elementy w kolejności wejścia', () => {
    const items = [
      { id: 'a', createdAt: iso(2026, 8, 3) },
      { id: 'b', createdAt: iso(2026, 8, 3, 8) },
      { id: 'c', createdAt: iso(2026, 7, 31) },
      { id: 'd', createdAt: iso(2024, 0, 1) },
    ];
    const groups = groupHistory(items, now);
    expect(groups.map((g) => g.id)).toEqual(['today', 'week', 'older']);
    expect(groups[0]?.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(groups[1]?.items.map((i) => i.id)).toEqual(['c']);
    expect(groups[2]?.items.map((i) => i.id)).toEqual(['d']);
  });

  it('groupHistory: pusta lista → brak sekcji', () => {
    expect(groupHistory([], now)).toEqual([]);
  });
});
