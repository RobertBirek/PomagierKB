import { describe, expect, it } from 'vitest';
import {
  diffObjects,
  formatDayHeading,
  formatDiffValue,
} from '../src/components/settings/audit-core';

describe('diffObjects() — diff before/after wpisu audytu', () => {
  it('brak zmian → wszystkie wiersze changed=false', () => {
    const rows = diffObjects({ a: 1, b: 'x' }, { a: 1, b: 'x' });
    expect(rows).toEqual([
      { key: 'a', before: '1', after: '1', changed: false },
      { key: 'b', before: '"x"', after: '"x"', changed: false },
    ]);
  });

  it('zmiana wartości, nowy klucz i klucz usunięty', () => {
    const rows = diffObjects({ a: 1, gone: true }, { a: 2, added: 'nowy' });
    expect(rows).toEqual([
      { key: 'a', before: '1', after: '2', changed: true },
      { key: 'gone', before: 'true', after: '—', changed: true },
      { key: 'added', before: '—', after: '"nowy"', changed: true },
    ]);
  });

  it('zagnieżdżone obiekty: głębokie porównanie, wartości jako JSON', () => {
    const same = diffObjects({ cfg: { limit: 5, tags: ['a'] } }, { cfg: { limit: 5, tags: ['a'] } });
    expect(same).toEqual([
      { key: 'cfg', before: '{"limit":5,"tags":["a"]}', after: '{"limit":5,"tags":["a"]}', changed: false },
    ]);
    const changed = diffObjects({ cfg: { limit: 5 } }, { cfg: { limit: 9 } });
    expect(changed?.[0]?.changed).toBe(true);
  });

  it('null po jednej stronie = {} (wpis tworzący zasób → wszystko changed)', () => {
    const rows = diffObjects(null, { name: 'Docs', status: 'active' });
    expect(rows).toEqual([
      { key: 'name', before: '—', after: '"Docs"', changed: true },
      { key: 'status', before: '—', after: '"active"', changed: true },
    ]);
    expect(diffObjects({ name: 'Docs' }, null)).toEqual([
      { key: 'name', before: '"Docs"', after: '—', changed: true },
    ]);
  });

  it('oba null → null (nic do pokazania)', () => {
    expect(diffObjects(null, null)).toBeNull();
  });

  it('nie-obiekty (string/liczba/tablica) → null (fallback CodeBlock w UI)', () => {
    expect(diffObjects('surowy tekst', { a: 1 })).toBeNull();
    expect(diffObjects({ a: 1 }, 42)).toBeNull();
    expect(diffObjects([1, 2], [1, 2])).toBeNull();
  });

  it('wartość null w polu vs brak pola są rozróżnialne', () => {
    const rows = diffObjects({ a: null }, {});
    expect(rows).toEqual([{ key: 'a', before: 'null', after: '—', changed: true }]);
  });
});

describe('formatDiffValue()', () => {
  it('undefined → em-dash; prymitywy i obiekty → JSON', () => {
    expect(formatDiffValue(undefined)).toBe('—');
    expect(formatDiffValue(null)).toBe('null');
    expect(formatDiffValue('x')).toBe('"x"');
    expect(formatDiffValue({ a: 1 })).toBe('{"a":1}');
  });
});

describe('formatDayHeading() — polski nagłówek dnia w tabeli audytu', () => {
  it('YYYY-MM-DD → „dzień tygodnia, D miesiąca RRRR"', () => {
    expect(formatDayHeading('2026-09-02')).toBe('środa, 2 września 2026');
    expect(formatDayHeading('2026-01-01')).toBe('czwartek, 1 stycznia 2026');
  });

  it('wejście spoza formatu wraca bez zmian (klucz grupy z surowego at)', () => {
    expect(formatDayHeading('timeout sondy')).toBe('timeout sondy');
    expect(formatDayHeading('2026-09-02T10:00:00Z')).toBe('2026-09-02T10:00:00Z');
  });
});
