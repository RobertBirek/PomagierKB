import { describe, expect, it } from 'vitest';
import { nextSort, pageRange, selectionState } from '../src/ui/data-table-core';

describe('pageRange()', () => {
  it('pierwsza strona pełna', () => {
    expect(pageRange(1, 20, 100)).toEqual({ from: 1, to: 20 });
  });

  it('środkowa strona', () => {
    expect(pageRange(3, 20, 100)).toEqual({ from: 41, to: 60 });
  });

  it('ostatnia strona częściowa — to sklejone do total', () => {
    expect(pageRange(3, 20, 45)).toEqual({ from: 41, to: 45 });
  });

  it('total=0 → {0,0}', () => {
    expect(pageRange(1, 20, 0)).toEqual({ from: 0, to: 0 });
  });

  it('strona poza zakresem → sklejona do total (defensywnie)', () => {
    expect(pageRange(9, 20, 45)).toEqual({ from: 45, to: 45 });
  });

  it('jeden element', () => {
    expect(pageRange(1, 20, 1)).toEqual({ from: 1, to: 1 });
  });
});

describe('nextSort()', () => {
  it('brak sortu → asc', () => {
    expect(nextSort(undefined, 'name')).toEqual({ key: 'name', dir: 'asc' });
  });

  it('inna kolumna → asc na nowej kolumnie', () => {
    expect(nextSort({ key: 'name', dir: 'desc' }, 'date')).toEqual({ key: 'date', dir: 'asc' });
  });

  it('asc → desc', () => {
    expect(nextSort({ key: 'name', dir: 'asc' }, 'name')).toEqual({ key: 'name', dir: 'desc' });
  });

  it('desc → undefined (koniec cyklu)', () => {
    expect(nextSort({ key: 'name', dir: 'desc' }, 'name')).toBeUndefined();
  });
});

describe('selectionState()', () => {
  it('brak widocznych wierszy → none', () => {
    expect(selectionState(['a'], [])).toBe('none');
  });

  it('nic nie zaznaczone → none', () => {
    expect(selectionState([], ['a', 'b'])).toBe('none');
  });

  it('część zaznaczona → some', () => {
    expect(selectionState(['a'], ['a', 'b', 'c'])).toBe('some');
  });

  it('wszystkie widoczne zaznaczone → all', () => {
    expect(selectionState(['a', 'b'], ['a', 'b'])).toBe('all');
  });

  it('zaznaczenia spoza strony nie psują wyniku (all)', () => {
    expect(selectionState(['x', 'a', 'b'], ['a', 'b'])).toBe('all');
  });

  it('zaznaczenia wyłącznie spoza strony → none', () => {
    expect(selectionState(['x', 'y'], ['a', 'b'])).toBe('none');
  });
});
