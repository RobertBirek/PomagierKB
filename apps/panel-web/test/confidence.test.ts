import { describe, expect, it } from 'vitest';
import {
  CONFIDENCE_HIGH_THRESHOLD,
  CONFIDENCE_MEDIUM_THRESHOLD,
  confidenceBadge,
  confidenceLevel,
} from '../src/lib/confidence';
import { pl } from '../src/i18n/pl';

describe('confidenceLevel()', () => {
  it('progi: ≥0.7 wysoka, ≥0.45 średnia, poniżej niska', () => {
    expect(confidenceLevel(0.95)).toBe('high');
    expect(confidenceLevel(CONFIDENCE_HIGH_THRESHOLD)).toBe('high');
    expect(confidenceLevel(0.69)).toBe('medium');
    expect(confidenceLevel(CONFIDENCE_MEDIUM_THRESHOLD)).toBe('medium');
    expect(confidenceLevel(0.44)).toBe('low');
    expect(confidenceLevel(0)).toBe('low');
  });

  it('brak wartości / NaN → defensywnie low (fail-closed)', () => {
    expect(confidenceLevel(null)).toBe('low');
    expect(confidenceLevel(undefined)).toBe('low');
    expect(confidenceLevel(Number.NaN)).toBe('low');
  });
});

describe('confidenceBadge()', () => {
  it('mapuje poziom na wariant plakietki i istniejący klucz PL', () => {
    const high = confidenceBadge(0.9);
    expect(high).toMatchObject({ level: 'high', variant: 'ok', labelKey: 'ask.confidence.high' });
    const medium = confidenceBadge(0.5);
    expect(medium).toMatchObject({ level: 'medium', variant: 'warn' });
    const low = confidenceBadge(0.1);
    expect(low).toMatchObject({ level: 'low', variant: 'fail' });
    // Klucze etykiet naprawdę istnieją w słowniku (żaden surowiec nie wycieka).
    for (const badge of [high, medium, low]) {
      expect(pl[badge.labelKey]).toBeTypeOf('string');
    }
  });
});
