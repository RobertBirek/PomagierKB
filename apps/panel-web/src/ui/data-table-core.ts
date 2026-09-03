/**
 * Czysta logika DataTable v2 (bez Reacta) — testowana w test/data-table-core.test.ts.
 * Trzy funkcje: zakres pozycji pagera, cykl sortowania i stan zaznaczenia nagłówka.
 */

export interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

/**
 * Zakres pozycji na stronie: „{from}–{to} z {total}".
 * total=0 → {0,0}; strona poza zakresem → sklejona do total (defensywnie).
 */
export function pageRange(
  page: number,
  pageSize: number,
  total: number,
): { from: number; to: number } {
  if (total <= 0) return { from: 0, to: 0 };
  const from = Math.min((page - 1) * pageSize + 1, total);
  const to = Math.min(page * pageSize, total);
  return { from, to };
}

/**
 * Cykl sortowania po kliknięciu nagłówka kolumny `key`:
 * brak/inna kolumna → asc → desc → undefined (bez sortowania).
 */
export function nextSort(current: SortState | undefined, key: string): SortState | undefined {
  if (current === undefined || current.key !== key) return { key, dir: 'asc' };
  if (current.dir === 'asc') return { key, dir: 'desc' };
  return undefined;
}

/**
 * Stan checkboxa „zaznacz wszystkie" względem WIDOCZNYCH wierszy:
 * 'none' (nic / brak wierszy), 'some' (część → indeterminate), 'all' (wszystkie).
 * Id-ki zaznaczone poza bieżącą stroną nie psują wyniku.
 */
export function selectionState(
  selected: readonly string[],
  visibleIds: readonly string[],
): 'none' | 'some' | 'all' {
  if (visibleIds.length === 0) return 'none';
  const set = new Set(selected);
  let count = 0;
  for (const id of visibleIds) if (set.has(id)) count += 1;
  if (count === 0) return 'none';
  return count === visibleIds.length ? 'all' : 'some';
}
