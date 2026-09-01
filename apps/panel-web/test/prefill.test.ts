import { describe, expect, it } from 'vitest';
import { buildAddLinkSearch, parseAddSearch, PREFILL_QUESTION_MAX } from '../src/lib/prefill';

describe('parseAddSearch() — prefill /add z search-params', () => {
  it('poprawne pytanie przechodzi (z trimem)', () => {
    expect(parseAddSearch({ question: '  Jaki czas dostawy Norlys?  ' })).toEqual({
      question: 'Jaki czas dostawy Norlys?',
    });
  });

  it('brak / pusty / nie-string → brak prefillu', () => {
    expect(parseAddSearch({})).toEqual({});
    expect(parseAddSearch({ question: '' })).toEqual({});
    expect(parseAddSearch({ question: '   ' })).toEqual({});
    expect(parseAddSearch({ question: 42 })).toEqual({});
    expect(parseAddSearch({ question: ['a'] })).toEqual({});
  });

  it('długie pytanie przycinane do limitu URL', () => {
    const long = 'x'.repeat(PREFILL_QUESTION_MAX + 100);
    const out = parseAddSearch({ question: long });
    expect(out.question).toHaveLength(PREFILL_QUESTION_MAX);
  });
});

describe('buildAddLinkSearch() — deep-link /ask → /add', () => {
  it('buduje search-params z pytania', () => {
    expect(buildAddLinkSearch('Ile IP65 ma oprawa X?')).toEqual({ question: 'Ile IP65 ma oprawa X?' });
  });

  it('puste pytanie → null (link na goły /add)', () => {
    expect(buildAddLinkSearch('   ')).toBeNull();
  });

  it('round-trip: to co zbuduje /ask, /add odczyta bez zmian', () => {
    const search = buildAddLinkSearch('  Zasilacz DALI — jaki model?  ');
    expect(search).not.toBeNull();
    expect(parseAddSearch(search as unknown as Record<string, unknown>)).toEqual(search);
  });
});
