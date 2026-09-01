import { describe, expect, it } from 'vitest';
import { normalizeHistory, normalizeHistoryItem } from '../src/lib/askHistory';

describe('normalizeHistoryItem()', () => {
  it('kształt camelCase (kontrakt API)', () => {
    expect(
      normalizeHistoryItem({
        id: 'ans_1',
        question: 'Jaki IP ma oprawa X?',
        confidence: 0.8,
        noAnswer: false,
        createdAt: '2026-09-01T10:00:00Z',
        verdict: 'up',
      }),
    ).toEqual({
      id: 'ans_1',
      question: 'Jaki IP ma oprawa X?',
      confidence: 0.8,
      noAnswer: false,
      createdAt: '2026-09-01T10:00:00Z',
      verdict: 'up',
    });
  });

  it('kształt snake_case (wiersz answers + tablica feedback)', () => {
    const item = normalizeHistoryItem({
      id: 'ans_2',
      question: 'Czas dostawy?',
      confidence: null,
      no_answer: 1,
      created_at: '2026-08-30T09:00:00Z',
      feedback: [{ verdict: 'up' }, { verdict: 'down' }],
    });
    expect(item).toEqual({
      id: 'ans_2',
      question: 'Czas dostawy?',
      confidence: null,
      noAnswer: true,
      createdAt: '2026-08-30T09:00:00Z',
      verdict: 'down', // ostatni werdykt wygrywa
    });
  });

  it('śmieci → null (brak id/question)', () => {
    expect(normalizeHistoryItem(null)).toBeNull();
    expect(normalizeHistoryItem('x')).toBeNull();
    expect(normalizeHistoryItem({ id: 'a' })).toBeNull();
    expect(normalizeHistoryItem({ question: 'b' })).toBeNull();
    expect(normalizeHistoryItem({ id: '', question: 'b' })).toBeNull();
  });
});

describe('normalizeHistory()', () => {
  it('akceptuje {items:[…]} i gołą tablicę; odsiewa złe pozycje', () => {
    const good = { id: 'a', question: 'q' };
    expect(normalizeHistory({ items: [good, { broken: true }] })).toHaveLength(1);
    expect(normalizeHistory([good])).toHaveLength(1);
  });

  it('inne kształty → pusta lista (strona nie pada)', () => {
    expect(normalizeHistory(undefined)).toEqual([]);
    expect(normalizeHistory({})).toEqual([]);
    expect(normalizeHistory('oops')).toEqual([]);
  });
});
