import { describe, expect, it } from 'vitest';
import { healthVariant, statusLabel, statusVariant } from '../src/lib/status';
import { pl } from '../src/i18n/pl';

describe('statusVariant()', () => {
  it('mapuje statusy domenowe na warianty plakietki', () => {
    expect(statusVariant('ok')).toBe('ok');
    expect(statusVariant('down')).toBe('fail');
    expect(statusVariant('running')).toBe('accent');
    expect(statusVariant('pending')).toBe('neutral');
    expect(statusVariant('failed')).toBe('fail');
    expect(statusVariant('active')).toBe('ok');
    expect(statusVariant('promoted')).toBe('ok');
    expect(statusVariant('rejected')).toBe('fail');
    expect(statusVariant('FINISH')).toBe('ok'); // builder job OpenSPG
    expect(statusVariant('ERROR')).toBe('fail');
  });
  it('nieznany status → fallback przez normalizeStatus, null → neutral', () => {
    expect(statusVariant('STALE')).toBe('warn');
    expect(statusVariant(null)).toBe('neutral');
    expect(statusVariant('xyz')).toBe('neutral');
  });
});

describe('statusLabel()', () => {
  it('zwraca polskie etykiety ze słownika', () => {
    expect(statusLabel('running')).toBe(pl['status.running']);
    expect(statusLabel('done')).toBe(pl['status.done']);
    expect(statusLabel('FINISH')).toBe(pl['status.done']); // perspektywa człowieka, nie joba
    expect(statusLabel('promoted')).toBe(pl['status.promoted']);
  });
  it('ŻADEN status nie wycieka po angielsku (soczewka product)', () => {
    for (const raw of ['SET_FINISH', 'weird_state', 'TERMINATE', null, undefined]) {
      const label = statusLabel(raw);
      expect(Object.values(pl)).toContain(label);
    }
  });
});

describe('healthVariant()', () => {
  it('HealthStatus → wariant plakietki', () => {
    expect(healthVariant('OK')).toBe('ok');
    expect(healthVariant('WARN')).toBe('warn');
    expect(healthVariant('FAIL')).toBe('fail');
    expect(healthVariant('UNKNOWN')).toBe('neutral');
  });
});
