import { describe, expect, it } from 'vitest';
import {
  formatMetadataValue,
  metadataEntries,
  piiWarning,
} from '../src/components/inbox/detailsList';

describe('formatMetadataValue()', () => {
  it('null/undefined/pusty string → —', () => {
    expect(formatMetadataValue(null)).toBe('—');
    expect(formatMetadataValue(undefined)).toBe('—');
    expect(formatMetadataValue('')).toBe('—');
  });

  it('boolean → tak/nie (słownik PL)', () => {
    expect(formatMetadataValue(true)).toBe('tak');
    expect(formatMetadataValue(false)).toBe('nie');
  });

  it('liczby → string; NaN/Infinity → —', () => {
    expect(formatMetadataValue(42)).toBe('42');
    expect(formatMetadataValue(0)).toBe('0');
    expect(formatMetadataValue(Number.NaN)).toBe('—');
    expect(formatMetadataValue(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('tablica prymitywów → lista po przecinku; pusta → —', () => {
    expect(formatMetadataValue(['a', 'b', 3])).toBe('a, b, 3');
    expect(formatMetadataValue([])).toBe('—');
  });

  it('obiekt / tablica zagnieżdżona → JSON', () => {
    expect(formatMetadataValue({ a: 1 })).toBe('{"a":1}');
    expect(formatMetadataValue([{ a: 1 }])).toBe('[{"a":1}]');
  });
});

describe('metadataEntries()', () => {
  it('zachowuje kolejność kluczy z API i formatuje wartości', () => {
    const entries = metadataEntries({
      originalName: 'plik.pdf',
      pages: 12,
      ocr: true,
      tags: ['a', 'b'],
    });
    expect(entries.map((e) => e.key)).toEqual(['originalName', 'pages', 'ocr', 'tags']);
    expect(entries.map((e) => e.value)).toEqual(['plik.pdf', '12', 'tak', 'a, b']);
    expect(entries.every((e) => !e.isDate)).toBe(true);
  });

  it('ISO-data z czasem oznaczona isDate (strona renderuje przez formatDateTime)', () => {
    const entries = metadataEntries({
      createdAt: '2026-03-12T14:05:00.000Z',
      offsetAt: '2026-03-12T14:05:00+02:00',
      plainDate: '2026-03-12',
      name: 'x',
    });
    expect(entries[0]?.isDate).toBe(true);
    expect(entries[1]?.isDate).toBe(true);
    // sama data bez czasu i zwykły string → nie-data
    expect(entries[2]?.isDate).toBe(false);
    expect(entries[3]?.isDate).toBe(false);
  });

  it('pusty obiekt → brak wpisów', () => {
    expect(metadataEntries({})).toEqual([]);
  });
});

describe('piiWarning', () => {
  it('brak sygnału, gdy metadanych PII nie ma albo licznik jest zerowy', () => {
    expect(piiWarning({})).toBeNull();
    expect(piiWarning({ pii: { total: 0, types: [], policy: 'flag' } })).toBeNull();
  });

  it('tłumaczy typy na polski i przenosi politykę', () => {
    const w = piiWarning({ pii: { total: 3, types: ['pesel', 'email'], policy: 'mask' } });
    expect(w).toEqual({ total: 3, types: ['PESEL', 'adres e-mail'], policy: 'mask' });
  });

  it('nieznany typ przechodzi surowy zamiast znikać (nowy detektor w backendzie)', () => {
    expect(piiWarning({ pii: { total: 1, types: ['paszport'], policy: 'flag' } })?.types).toEqual([
      'paszport',
    ]);
  });

  it('uszkodzony kształt nie wywraca panelu recenzenta', () => {
    expect(piiWarning({ pii: 'tak' })).toBeNull();
    expect(piiWarning({ pii: [] })).toBeNull();
    expect(piiWarning({ pii: { total: 'dużo' } })).toBeNull();
    // Brak `types`/`policy` przy poprawnym liczniku → sygnał zostaje, z bezpiecznymi domyślnymi.
    expect(piiWarning({ pii: { total: 2 } })).toEqual({ total: 2, types: [], policy: 'flag' });
  });
});
