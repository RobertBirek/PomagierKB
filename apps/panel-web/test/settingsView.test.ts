import { describe, expect, it } from 'vitest';
import { coerceNumberSetting, groupByDay, maskSecret } from '../src/lib/settingsView';

describe('maskSecret() — lustro maskValue z shared/db (podgląd „skonfigurowany: ab***yz")', () => {
  it('maskuje długi sekret do 2+***+2 znaków', () => {
    expect(maskSecret('sk-abcdef123456yz')).toBe('sk***yz');
    expect(maskSecret('abcdefgh')).toBe('ab***gh');
  });

  it('krótki sekret (<8 znaków) → same gwiazdki (bez wycieku treści)', () => {
    expect(maskSecret('krotki')).toBe('***');
    expect(maskSecret('a')).toBe('***');
  });

  it('pusta wartość → pusty podgląd', () => {
    expect(maskSecret('')).toBe('');
  });

  it('nigdy nie zwraca pełnej wartości sekretu', () => {
    const secret = 'sk-super-tajny-klucz-9000';
    expect(maskSecret(secret)).not.toContain(secret.slice(3, -3));
  });
});

describe('coerceNumberSetting() — defensywny odczyt progu z GET /settings', () => {
  it('liczba wprost i obiekt {value} przechodzą', () => {
    expect(coerceNumberSetting(0.45, 0.1)).toBe(0.45);
    expect(coerceNumberSetting({ value: 0.6 }, 0.1)).toBe(0.6);
  });

  it('śmieci → fallback (string, null, NaN, obiekt bez value)', () => {
    expect(coerceNumberSetting('0.45', 0.1)).toBe(0.1);
    expect(coerceNumberSetting(null, 0.1)).toBe(0.1);
    expect(coerceNumberSetting(Number.NaN, 0.1)).toBe(0.1);
    expect(coerceNumberSetting({ threshold: 0.5 }, 0.1)).toBe(0.1);
    expect(coerceNumberSetting(undefined, 0.1)).toBe(0.1);
  });
});

describe('groupByDay() — nagłówki dzienne przeglądarki audytu', () => {
  const entries = [
    { seq: 5, at: '2026-09-01T14:30:00.000Z' },
    { seq: 4, at: '2026-09-01T09:00:00.000Z' },
    { seq: 3, at: '2026-08-31T23:59:59.000Z' },
    { seq: 2, at: '2026-08-29T08:00:00.000Z' },
    { seq: 1, at: '2026-08-29T07:00:00.000Z' },
  ];

  it('grupuje po dniu ISO zachowując kolejność wejścia (najnowsze najpierw)', () => {
    const groups = groupByDay(entries);
    expect(groups.map((g) => g.day)).toEqual(['2026-09-01', '2026-08-31', '2026-08-29']);
    expect(groups[0]?.items.map((i) => i.seq)).toEqual([5, 4]);
    expect(groups[1]?.items.map((i) => i.seq)).toEqual([3]);
    expect(groups[2]?.items.map((i) => i.seq)).toEqual([2, 1]);
  });

  it('nic nie znika: suma elementów grup = liczba wpisów', () => {
    const groups = groupByDay(entries);
    expect(groups.reduce((n, g) => n + g.items.length, 0)).toBe(entries.length);
  });

  it('pusta lista → brak grup', () => {
    expect(groupByDay([])).toEqual([]);
  });

  it('wpis z at spoza ISO trafia do osobnej grupy z surową wartością (bez utraty)', () => {
    const groups = groupByDay([{ at: 'zepsuta-data' }, { at: '2026-09-01T10:00:00.000Z' }]);
    expect(groups.map((g) => g.day)).toEqual(['zepsuta-data', '2026-09-01']);
  });
});
