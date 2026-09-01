/**
 * Reducer selekcji bulk w Inboxie — CZYSTA logika bez React/DOM (useReducer
 * na stronie tylko go podpina). Stan = tablica id w kolejności zaznaczania,
 * bez duplikatów. Testy: test/bulkSelection.test.ts.
 */

export type BulkSelectionAction =
  | { type: 'toggle'; id: string }
  | { type: 'selectMany'; ids: readonly string[] }
  | { type: 'deselectMany'; ids: readonly string[] }
  | { type: 'clear' }
  /** Po refetchu listy: zostają tylko id nadal widoczne/wybieralne. */
  | { type: 'prune'; keep: readonly string[] };

export function bulkSelectionReducer(
  state: readonly string[],
  action: BulkSelectionAction,
): readonly string[] {
  switch (action.type) {
    case 'toggle':
      return state.includes(action.id)
        ? state.filter((id) => id !== action.id)
        : [...state, action.id];
    case 'selectMany': {
      const next = [...state];
      for (const id of action.ids) if (!next.includes(id)) next.push(id);
      return next;
    }
    case 'deselectMany': {
      const drop = new Set(action.ids);
      return state.filter((id) => !drop.has(id));
    }
    case 'clear':
      return state.length === 0 ? state : [];
    case 'prune': {
      const keep = new Set(action.keep);
      const next = state.filter((id) => keep.has(id));
      return next.length === state.length ? state : next;
    }
    default:
      return state;
  }
}

/** Czy wszystkie podane id są zaznaczone (pusta lista → false, nie „tak"). */
export function allSelected(state: readonly string[], ids: readonly string[]): boolean {
  if (ids.length === 0) return false;
  const set = new Set(state);
  return ids.every((id) => set.has(id));
}
