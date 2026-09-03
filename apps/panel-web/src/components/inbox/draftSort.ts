/**
 * Sort KLIENCKI per-strona listy szkiców (API nie ma sort-param — decyzja
 * z planu: sort na bieżącej stronie z tooltipem). CZYSTA logika bez React.
 */
import type { SortState } from '../../ui/data-table-core';

export interface DraftSortable {
  title: string;
  createdAt: string;
  status: string;
}

/** Klucze kolumn sortowalnych (zgodne z key w columns DataTable). */
export const DRAFT_SORT_KEYS = ['title', 'date', 'status'] as const;

/** Stabilna kopia posortowana wg sort; undefined → kolejność z API. */
export function sortDrafts<T extends DraftSortable>(
  rows: readonly T[],
  sort: SortState | undefined,
): readonly T[] {
  if (sort === undefined) return rows;
  const dir = sort.dir === 'asc' ? 1 : -1;
  const compare = (a: T, b: T): number => {
    switch (sort.key) {
      case 'title':
        return a.title.localeCompare(b.title, 'pl') * dir;
      case 'date':
        // ISO 8601 porównuje się leksykograficznie.
        return a.createdAt.localeCompare(b.createdAt) * dir;
      case 'status':
        return a.status.localeCompare(b.status) * dir;
      default:
        return 0;
    }
  };
  return [...rows].sort(compare);
}
