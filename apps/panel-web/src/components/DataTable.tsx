import type { ReactNode } from 'react';
import { t } from '../i18n/t';

export interface Column<T> {
  key: string;
  header: string;
  /** Kolumna sortowalna — klik w nagłówek woła onSortChange. */
  sortable?: boolean;
  render: (row: T) => ReactNode;
  width?: string;
}

export interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

export interface DataTableProps<T> {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** Sortowanie KONTROLOWANE (strona trzyma stan / search-params). */
  sort?: SortState;
  onSortChange?: (sort: SortState) => void;
  /** Paginacja KONTROLOWANA: page od 1. */
  page?: number;
  pageCount?: number;
  onPageChange?: (page: number) => void;
  onRowClick?: (row: T) => void;
  /** Zawartość przy pustych rows (np. <EmptyState/>). */
  empty?: ReactNode;
}

/** Tabela headless: sort/paginacja/selekcja w rękach strony; tu tylko render. */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  sort,
  onSortChange,
  page,
  pageCount,
  onPageChange,
  onRowClick,
  empty,
}: DataTableProps<T>) {
  if (rows.length === 0 && empty !== undefined) return <>{empty}</>;

  function headerCell(col: Column<T>): ReactNode {
    if (col.sortable !== true || onSortChange === undefined) return col.header;
    const active = sort?.key === col.key;
    const nextDir: SortState['dir'] = active && sort?.dir === 'asc' ? 'desc' : 'asc';
    return (
      <button
        type="button"
        title={t('table.sortBy', { column: col.header })}
        aria-sort={active ? (sort?.dir === 'asc' ? 'ascending' : 'descending') : undefined}
        onClick={() => onSortChange({ key: col.key, dir: nextDir })}
      >
        {col.header} {active ? (sort?.dir === 'asc' ? '↑' : '↓') : '↕'}
      </button>
    );
  }

  const showPager = page !== undefined && pageCount !== undefined && onPageChange !== undefined && pageCount > 1;

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} style={col.width !== undefined ? { width: col.width } : undefined}>
                {headerCell(col)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              data-clickable={onRowClick !== undefined ? 'true' : undefined}
              onClick={onRowClick !== undefined ? () => onRowClick(row) : undefined}
            >
              {columns.map((col) => (
                <td key={col.key}>{col.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {showPager && (
        <div className="table-pager">
          <span className="muted">{t('common.page', { page, pages: pageCount })}</span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={page <= 1}
            aria-label={t('common.prevPage')}
            onClick={() => onPageChange(page - 1)}
          >
            ←
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={page >= pageCount}
            aria-label={t('common.nextPage')}
            onClick={() => onPageChange(page + 1)}
          >
            →
          </button>
        </div>
      )}
    </div>
  );
}
