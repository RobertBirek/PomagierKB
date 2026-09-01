import { describe, expect, it } from 'vitest';
import { allSelected, bulkSelectionReducer } from '../src/lib/bulkSelection';

describe('bulkSelectionReducer()', () => {
  it('toggle dodaje i zdejmuje id bez duplikatów', () => {
    let state: readonly string[] = [];
    state = bulkSelectionReducer(state, { type: 'toggle', id: 'a' });
    expect(state).toEqual(['a']);
    state = bulkSelectionReducer(state, { type: 'toggle', id: 'b' });
    expect(state).toEqual(['a', 'b']);
    state = bulkSelectionReducer(state, { type: 'toggle', id: 'a' });
    expect(state).toEqual(['b']);
  });

  it('selectMany robi unię zachowując kolejność i bez duplikatów', () => {
    const state = bulkSelectionReducer(['a', 'b'], { type: 'selectMany', ids: ['b', 'c', 'd'] });
    expect(state).toEqual(['a', 'b', 'c', 'd']);
  });

  it('deselectMany usuwa tylko wskazane id', () => {
    const state = bulkSelectionReducer(['a', 'b', 'c'], { type: 'deselectMany', ids: ['b', 'x'] });
    expect(state).toEqual(['a', 'c']);
  });

  it('clear czyści; pusty stan zwraca tę samą referencję (bez re-renderu)', () => {
    expect(bulkSelectionReducer(['a'], { type: 'clear' })).toEqual([]);
    const empty: readonly string[] = [];
    expect(bulkSelectionReducer(empty, { type: 'clear' })).toBe(empty);
  });

  it('prune zostawia tylko id z keep (po refetchu listy)', () => {
    const state = bulkSelectionReducer(['a', 'b', 'c'], { type: 'prune', keep: ['c', 'a', 'z'] });
    expect(state).toEqual(['a', 'c']);
  });

  it('prune bez zmian zwraca tę samą referencję (stabilność useEffect)', () => {
    const state: readonly string[] = ['a', 'b'];
    expect(bulkSelectionReducer(state, { type: 'prune', keep: ['a', 'b', 'c'] })).toBe(state);
  });
});

describe('allSelected()', () => {
  it('true tylko gdy wszystkie id są w selekcji', () => {
    expect(allSelected(['a', 'b', 'c'], ['a', 'b'])).toBe(true);
    expect(allSelected(['a'], ['a', 'b'])).toBe(false);
  });

  it('pusta lista kandydatów → false (przycisk „zaznacz stronę" nie znika)', () => {
    expect(allSelected(['a'], [])).toBe(false);
    expect(allSelected([], [])).toBe(false);
  });
});
