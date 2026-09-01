import { describe, expect, it } from 'vitest';
import { formatDateTime, t } from '../src/i18n/t';
import { pl } from '../src/i18n/pl';

describe('t()', () => {
  it('zwraca tekst ze słownika', () => {
    expect(t('common.save')).toBe(pl['common.save']);
  });

  it('interpoluje parametry {name} (string i liczba)', () => {
    expect(t('common.page', { page: 2, pages: 9 })).toBe('Strona 2 z 9');
    expect(t('header.loggedInAs', { name: 'Ala' })).toBe('Zalogowano jako Ala');
  });

  it('brakujący parametr zostawia placeholder (widoczne w QA, bez crasha)', () => {
    expect(t('common.page', { page: 2 })).toBe('Strona 2 z {pages}');
    expect(t('common.page')).toBe(pl['common.page']);
  });

  it('słownik nie ma pustych wartości', () => {
    for (const [key, value] of Object.entries(pl)) {
      expect(value, `pusty klucz: ${key}`).not.toBe('');
    }
  });
});

describe('formatDateTime()', () => {
  it('niepoprawne ISO wraca bez zmian (bez "Invalid Date" w UI)', () => {
    expect(formatDateTime('nie-data')).toBe('nie-data');
  });
  it('poprawna data formatowana po polsku (zawiera rok i godzinę)', () => {
    const out = formatDateTime('2026-03-12T14:05:00Z');
    expect(out).toContain('2026');
    expect(out).toMatch(/\d{2}:\d{2}/);
  });
});
